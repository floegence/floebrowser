// floebrowser-media is a local source helper. Control uses stdin/stdout; encoded
// packets use a separate inherited pipe (fd 3), never the control carrier.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/floegence/floebrowser/media"
)

type command struct {
	ID        string      `json:"id"`
	Collector string      `json:"collector"`
	Op        string      `json:"op"`
	Scope     media.Scope `json:"scope"`
	SDP       string      `json:"sdp"`
}

func main() {
	frames := os.NewFile(3, "media-frames")
	if frames == nil {
		os.Exit(1)
	}
	defer frames.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	collectors := map[string]*media.Collector{}
	defer func() {
		for _, c := range collectors {
			_ = c.Close()
		}
	}()
	var writes sync.Mutex
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 65536)
	for scanner.Scan() {
		var cmd command
		if json.Unmarshal(scanner.Bytes(), &cmd) != nil || cmd.ID == "" || len(cmd.ID) > 80 || cmd.Collector == "" || len(cmd.Collector) > 80 {
			break
		}
		result := map[string]any{"id": cmd.ID}
		switch cmd.Op {
		case "open":
			if collectors[cmd.Collector] != nil || len(collectors) >= 64 {
				result["error"] = "collector_unavailable"
				break
			}
			c, err := media.NewCollector(cmd.Scope, func(track *media.Track) {
				go func() {
					for {
						packet, err := track.Next(ctx)
						if err != nil {
							return
						}
						writes.Lock()
						err = media.WritePacket(frames, packet)
						writes.Unlock()
						if err != nil {
							cancel()
							return
						}
					}
				}()
			})
			if err != nil {
				result["error"] = "collector_unavailable"
				break
			}
			negotiation, done := context.WithTimeout(ctx, 5*time.Second)
			answer, err := c.Answer(negotiation, cmd.SDP)
			done()
			if err != nil {
				_ = c.Close()
				result["error"] = "source_media_unavailable"
				break
			}
			collectors[cmd.Collector] = c
			result["sdp"] = answer
		case "keyframe":
			if c := collectors[cmd.Collector]; c != nil {
				c.RequestKeyframe()
			}
		case "close":
			if c := collectors[cmd.Collector]; c != nil {
				_ = c.Close()
				delete(collectors, cmd.Collector)
			}
		default:
			result["error"] = "invalid_command"
		}
		body, _ := json.Marshal(result)
		if _, err := fmt.Fprintln(os.Stdout, string(body)); err != nil {
			return
		}
	}
}
