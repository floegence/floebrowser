package media

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestExpiredVideoRequestsKeyframeWithoutWaitingForAnotherDelta(t *testing.T) {
	q := NewQueue(QueueLimits{Age: time.Second})
	q.Push(fixturePacket())
	q.packets[0].received = time.Now().Add(-2 * time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := q.Next(ctx); !errors.Is(err, ErrKeyframeRequired) {
		t.Fatalf("expired video must request a keyframe immediately: %v", err)
	}
}

func TestStaticCanvasSurvivesIdleConsumer(t *testing.T) {
	q := NewQueue(QueueLimits{Age: time.Second})
	p := fixturePacket()
	p.Header.Track, p.Header.Codec = "canvas", "webp"
	q.Push(p)
	q.packets[0].received = time.Now().Add(-2 * time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := q.Next(ctx); err != nil {
		t.Fatalf("latest complete static canvas was discarded: %v", err)
	}
}

func TestVideoQueueDropsDependentsUntilFreshKeyframe(t *testing.T) {
	q := NewQueue(QueueLimits{Packets: 2, Bytes: 100, Age: time.Second})
	p := fixturePacket()
	if q.Push(p) {
		t.Fatal("keyframe requested for valid initial keyframe")
	}
	p.Header.Keyframe = false
	if q.Push(p) {
		t.Fatal("queue filled early")
	}
	if !q.Push(p) {
		t.Fatal("overflow did not request a fresh keyframe")
	}
	if !q.Push(p) {
		t.Fatal("dependent delta frame admitted after reference loss")
	}
	p.Header.Keyframe = true
	p.Header.TimestampUS = 50000
	if q.Push(p) {
		t.Fatal("fresh keyframe rejected")
	}
	got, err := q.Next(context.Background())
	if err != nil || !got.Header.Keyframe || got.Header.TimestampUS != 50000 {
		t.Fatalf("stale picture escaped queue: %v %#v", err, got.Header)
	}
	q.Close()
	if _, err = q.Next(context.Background()); err == nil {
		t.Fatal("closed queue still readable")
	}
}

func TestCanvasQueueKeepsOnlyLatestCompletePicture(t *testing.T) {
	q := NewQueue(QueueLimits{Packets: 8, Bytes: 100, Age: time.Second})
	p := fixturePacket()
	p.Header.Codec = "webp"
	p.Header.Track = "canvas"
	for i := range 20 {
		p.Header.TimestampUS = int64(i)
		q.Push(p)
	}
	got, err := q.Next(context.Background())
	if err != nil || got.Header.TimestampUS != 19 {
		t.Fatalf("canvas backlog: %#v %v", got.Header, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = q.Next(ctx); err == nil {
		t.Fatal("empty queue ignored cancellation")
	}
}
