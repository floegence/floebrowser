package media

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
	webrtcmedia "github.com/pion/webrtc/v4/pkg/media"
)

func TestCollectorNegotiatesOnlyLoopbackWithoutRelay(t *testing.T) {
	sender, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer sender.Close()
	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "video", "source")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = sender.AddTrack(track); err != nil {
		t.Fatal(err)
	}
	offer, err := sender.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = sender.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	collector, err := NewCollector(Scope{Target: "t", View: "v", Stream: "s", Node: 1, Width: 640, Height: 360}, func(*Track) {})
	if err != nil {
		t.Fatal(err)
	}
	defer collector.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	answer, err := collector.Answer(ctx, offer.SDP)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(answer, "a=ice-lite") {
		t.Fatal("collector must not initiate external ICE probes")
	}
	candidates := 0
	for line := range strings.SplitSeq(answer, "\n") {
		if !strings.HasPrefix(line, "a=candidate:") {
			continue
		}
		candidates++
		fields := strings.Fields(line)
		if len(fields) < 8 || !net.ParseIP(fields[4]).IsLoopback() || fields[7] != "host" {
			t.Fatalf("non-loopback candidate: %q", line)
		}
	}
	if candidates == 0 {
		t.Fatal("collector did not expose a loopback candidate")
	}
	if err = sender.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
		t.Fatal(err)
	}
}

func TestCollectorDeliversAnIsolatedLastVideoFrame(t *testing.T) {
	sender, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer sender.Close()
	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "video", "source")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = sender.AddTrack(track); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	packets := make(chan Packet, 1)
	collector, err := NewCollector(Scope{Target: "t", View: "v", Stream: "s", Node: 1}, func(track *Track) {
		go func() {
			if p, err := track.Next(ctx); err == nil {
				packets <- p
			}
		}()
	})
	if err != nil {
		t.Fatal(err)
	}
	defer collector.Close()
	connected := make(chan struct{}, 1)
	sender.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateConnected {
			select {
			case connected <- struct{}{}:
			default:
			}
		}
	})
	offer, err := sender.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = sender.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	answer, err := collector.Answer(ctx, offer.SDP)
	if err != nil {
		t.Fatal(err)
	}
	if err = sender.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-connected:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	// One complete access unit with a VP8 keyframe header. There is deliberately
	// no later timestamp to trigger samplebuilder's normal duration calculation.
	data := []byte{0, 0, 0, 0x9d, 1, 0x2a, 64, 0, 32, 0, 0}
	if err = track.WriteSample(webrtcmedia.Sample{Data: data, Duration: 40 * time.Millisecond}); err != nil {
		t.Fatal(err)
	}
	select {
	case p := <-packets:
		if !p.Header.Keyframe || p.Header.Width != 64 || p.Header.Height != 32 {
			t.Fatalf("invalid last picture: %#v", p.Header)
		}
	case <-ctx.Done():
		t.Fatal("the last picture was retained until another source frame arrived")
	}
}

func TestCollectorRejectsUnboundIdentity(t *testing.T) {
	if _, err := NewCollector(Scope{Target: "target"}, func(*Track) {}); err == nil {
		t.Fatal("unbound collector admitted")
	}
}
