package media

import (
	"context"
	"errors"
	"sync"
	"time"
)

var ErrClosed = errors.New("media subscription closed")
var ErrKeyframeRequired = errors.New("media video reference expired")

type QueueLimits struct {
	Packets, Bytes int
	Age            time.Duration
}
type queued struct {
	packet   Packet
	received time.Time
}

// Queue belongs to one encoded track. A lost video reference invalidates all
// queued dependent frames. Canvas and audio have independent packet boundaries.
type Queue struct {
	mu      sync.Mutex
	limits  QueueLimits
	packets []queued
	bytes   int
	needKey bool
	closed  bool
	wake    chan struct{}
}

func NewQueue(limits QueueLimits) *Queue {
	if limits.Packets <= 0 {
		limits.Packets = 8
	}
	if limits.Bytes <= 0 {
		limits.Bytes = 4 * 1024 * 1024
	}
	if limits.Age <= 0 {
		limits.Age = 250 * time.Millisecond
	}
	return &Queue{limits: limits, needKey: true, wake: make(chan struct{}, 1)}
}

// Push takes ownership of packet.Data and never blocks source collection.
// A true result requests a fresh keyframe; the caller must not repeat input.
func (q *Queue) Push(p Packet) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return false
	}
	video := p.Header.Track == "video"
	if len(p.Data) > q.limits.Bytes {
		if video {
			q.clear()
			q.needKey = true
		}
		return video
	}
	if p.Header.Track == "canvas" || len(q.packets) > 0 && time.Since(q.packets[0].received) > q.limits.Age || len(q.packets) >= q.limits.Packets || q.bytes+len(p.Data) > q.limits.Bytes {
		q.clear()
		if video {
			q.needKey = true
		}
	}
	if video && q.needKey && !p.Header.Keyframe {
		return true
	}
	if video && p.Header.Keyframe {
		q.needKey = false
	}
	q.packets = append(q.packets, queued{p, time.Now()})
	q.bytes += len(p.Data)
	select {
	case q.wake <- struct{}{}:
	default:
	}
	return false
}

func (q *Queue) Next(ctx context.Context) (Packet, error) {
	for {
		if err := ctx.Err(); err != nil {
			return Packet{}, err
		}
		q.mu.Lock()
		if q.closed {
			q.mu.Unlock()
			return Packet{}, ErrClosed
		}
		if len(q.packets) > 0 {
			v := q.packets[0]
			if v.packet.Header.Track != "canvas" && time.Since(v.received) > q.limits.Age {
				q.clear()
				q.needKey = true
				q.mu.Unlock()
				if v.packet.Header.Track == "video" {
					return Packet{}, ErrKeyframeRequired
				}
				continue
			}
			q.packets[0] = queued{}
			q.packets = q.packets[1:]
			q.bytes -= len(v.packet.Data)
			q.mu.Unlock()
			return v.packet, nil
		}
		q.mu.Unlock()
		select {
		case <-ctx.Done():
			return Packet{}, ctx.Err()
		case <-q.wake:
		}
	}
}

func (q *Queue) clear() { clear(q.packets); q.packets = nil; q.bytes = 0 }

// Invalidate discards dependent video frames after local capture packet loss.
func (q *Queue) Invalidate() { q.mu.Lock(); q.clear(); q.needKey = true; q.mu.Unlock() }
func (q *Queue) Close() {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return
	}
	q.closed = true
	q.clear()
	close(q.wake)
}
