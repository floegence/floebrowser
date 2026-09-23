package media

import (
	"testing"
	"time"

	"github.com/pion/rtp"
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

func TestCaptureClockPreservesOffsetsAndRejectsMalformedExtensions(t *testing.T) {
	started := time.Unix(1_700_000_000, 0)
	clock := &trackClock{started: started, rate: 48000}
	for _, size := range []int{0, 7, 9, 15, 17} {
		clock.capture(1000, make([]byte, size))
		if got := clock.timestamp(1000); got != -1 {
			t.Fatalf("malformed %d-byte extension established time %d", size, got)
		}
	}
	for _, offset := range []time.Duration{-100 * time.Millisecond, 100 * time.Millisecond} {
		payload, err := rtp.NewAbsCaptureTimeExtensionWithCaptureClockOffset(started.Add(time.Second), offset).Marshal()
		if err != nil {
			t.Fatal(err)
		}
		clock.capture(0xffffff00, payload)
		want := (time.Second + offset + 20*time.Millisecond).Microseconds()
		if got := clock.timestamp(0x000002c0); got < want-1 || got > want {
			t.Fatalf("capture time with offset %s = %d, want %d us", offset, got, want)
		}
	}
}
