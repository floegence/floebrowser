package media

import (
	"testing"
	"time"
)

func TestTrackClocksPreserveOneSourceTimeline(t *testing.T) {
	started := time.Unix(1_700_000_000, 0)
	// Audio and video use independent random RTP origins and rates. Sender
	// reports map them to the same wall clock, including video RTP wraparound.
	video := &trackClock{started: started, rate: 90000}
	audio := &trackClock{started: started, rate: 48000}
	if got := audio.timestamp(7960); got != -1 {
		t.Fatalf("unsynchronized presentation time = %d, want invalid", got)
	}
	ntp := uint64(started.Unix()+2208988800)<<32 | uint64(1)<<30
	video.report(0xffffff00, ntp)
	audio.report(7000, ntp)
	if got := video.timestamp(0x00000608); got != 270000 {
		t.Fatalf("video presentation time = %d, want 270000 us", got)
	}
	if got := audio.timestamp(7960); got != 270000 {
		t.Fatalf("audio presentation time = %d, want 270000 us", got)
	}
	// A delayed first audio delivery must retain its source offset; it cannot
	// be rebased to the first decoded video frame by a downstream consumer.
	if got := audio.timestamp(12760); got != 370000 {
		t.Fatalf("later audio presentation time = %d, want 370000 us", got)
	}
}
