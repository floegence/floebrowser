// A disposable loopback fixture, using only released Flowersec public APIs.
package main

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	flowersec "github.com/floegence/flowersec/flowersec-go/v5"
	"github.com/floegence/flowersec/flowersec-go/v5/controlplane"
)

func main() {
	if err := serve(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func serve() error {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()
	origin := "http://" + listener.Addr().String()
	tokenBytes := make([]byte, 32)
	if _, err = rand.Read(tokenBytes); err != nil {
		return err
	}
	token := hex.EncodeToString(tokenBytes)
	issued, err := controlplane.NewIssuer().IssuePrivateLoopbackDirect(controlplane.PrivateLoopbackIssueOptions{
		Session:           controlplane.SessionOptions{ChannelID: "floebrowser-mixed-lanes", ExpiresAt: time.Now().Add(2 * time.Minute)},
		Endpoint:          "ws://" + listener.Addr().String() + flowersec.WebSocketDirectPath,
		RendezvousGroupID: "qualification", ListenerAudience: "fixture", UpstreamAddress: listener.Addr().String(),
	})
	if err != nil {
		return err
	}
	handlers, err := flowersec.NewSessionHandlers(flowersec.SessionHandlerOptions{})
	if err != nil {
		return err
	}
	var gateMu sync.Mutex
	gate := make(chan struct{})
	close(gate)
	err = handlers.HandleStream("qualification/control", func(ctx context.Context, incoming flowersec.IncomingStream) error {
		b := make([]byte, 1)
		for {
			if _, err := io.ReadFull(incoming.Stream, b); err != nil {
				return err
			}
			gateMu.Lock()
			if b[0] == 2 {
				select {
				case <-gate:
					gate = make(chan struct{})
				default:
				}
			}
			if b[0] == 3 {
				select {
				case <-gate:
				default:
					close(gate)
				}
			}
			gateMu.Unlock()
			if _, err := incoming.Stream.Write(b); err != nil {
				return err
			}
		}
	})
	if err != nil {
		return err
	}
	err = handlers.HandleStream("qualification/media", func(ctx context.Context, incoming flowersec.IncomingStream) error {
		prefix := make([]byte, 4)
		ack := make([]byte, 8)
		var consumed uint64
		for {
			gateMu.Lock()
			current := gate
			gateMu.Unlock()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-current:
			}
			if _, err := io.ReadFull(incoming.Stream, prefix); err != nil {
				return err
			}
			length := binary.BigEndian.Uint32(prefix)
			if length == 0 || length > 16*1024 {
				return errors.New("invalid media metadata length")
			}
			metadata := make([]byte, length)
			if _, err := io.ReadFull(incoming.Stream, metadata); err != nil {
				return err
			}
			var header struct {
				Bytes int `json:"bytes"`
			}
			if err := json.Unmarshal(metadata, &header); err != nil {
				return err
			}
			if header.Bytes < 1 || header.Bytes > 2*1024*1024 {
				return errors.New("invalid media payload length")
			}
			if _, err := io.CopyN(io.Discard, incoming.Stream, int64(header.Bytes)); err != nil {
				return err
			}
			// MediaSender credit is cumulative encoded-byte consumption, including
			// the length prefix and metadata carried on this qualification stream.
			consumed += uint64(4) + uint64(length) + uint64(header.Bytes)
			binary.BigEndian.PutUint64(ack, consumed)
			if _, err := incoming.Stream.Write(ack); err != nil {
				return err
			}
		}
	})
	if err != nil {
		return err
	}
	err = handlers.HandleStream("qualification/resource", func(ctx context.Context, incoming flowersec.IncomingStream) error {
		n, err := io.Copy(io.Discard, incoming.Stream)
		if err != nil {
			return err
		}
		b := make([]byte, 8)
		binary.BigEndian.PutUint64(b, uint64(n))
		_, err = incoming.Stream.Write(b)
		return err
	})
	if err != nil {
		return err
	}
	err = handlers.HandleStream("qualification/stalled", func(ctx context.Context, incoming flowersec.IncomingStream) error {
		// Read no payload until the Session closes. Reset must still cancel its writer.
		<-ctx.Done()
		return ctx.Err()
	})
	if err != nil {
		return err
	}
	var reserved atomic.Bool
	acceptor, err := flowersec.NewAcceptor(flowersec.AcceptorOptions{
		AllowedOrigins: []string{origin},
		Authorize: func(ctx context.Context, request controlplane.RuntimeAuthorizationRequest) (controlplane.AuthorizationResponse, error) {
			if !reserved.CompareAndSwap(false, true) {
				return controlplane.AuthorizationResponse{}, errors.New("fixture lease already reserved")
			}
			return controlplane.AuthorizeRuntime(request, issued.AuthorizationRecord(), "fixture-one-shot")
		},
		ResolveHandlers: func(context.Context, controlplane.RuntimeAuthorizationRequest) (*flowersec.SessionHandlers, error) {
			return handlers, nil
		},
		OnSession: func(ctx context.Context, session flowersec.Session, _ string) error {
			_, err := session.WaitTermination(ctx)
			return err
		},
	})
	if err != nil {
		return err
	}
	authorized := func(r *http.Request) bool {
		cookie, err := r.Cookie("fixture")
		return err == nil && cookie.Value == token
	}
	direct, err := acceptor.PrivateLoopbackHandler(flowersec.PrivateLoopbackHandlerOptions{AuthorizeRequest: authorized})
	if err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.Handle(flowersec.WebSocketDirectPath, direct)
	mux.HandleFunc("/"+token+"/", func(w http.ResponseWriter, r *http.Request) {
		if r.Host != listener.Addr().String() || r.Method != "GET" {
			http.Error(w, "Forbidden", 403)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		if r.URL.Path == "/"+token+"/" {
			http.SetCookie(w, &http.Cookie{Name: "fixture", Value: token, Path: "/", HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode})
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, "<!doctype html><title>Flowersec mixed lanes</title>")
			return
		}
		if r.URL.Path == "/"+token+"/artifact" && authorized(r) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(issued.ArtifactJSON())
			return
		}
		http.NotFound(w, r)
	})
	if err = json.NewEncoder(os.Stdout).Encode(map[string]string{"url": origin + "/" + token + "/"}); err != nil {
		return err
	}
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	return server.Serve(listener)
}
