package media

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
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
	for _, size := range []int{11, 128 * 1024, 40 * 1024} {
		t.Run(fmt.Sprintf("bytes-%d", size), func(t *testing.T) {
			// Disable periodic reports so this test controls the first source clock.
			sender, err := webrtc.NewAPI(webrtc.WithInterceptorRegistry(&interceptor.Registry{})).NewPeerConnection(webrtc.Configuration{})
			if err != nil {
				t.Fatal(err)
			}
			defer sender.Close()
			track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "video", "source")
			if err != nil {
				t.Fatal(err)
			}
			rtpSender, err := sender.AddTrack(track)
			if err != nil {
				t.Fatal(err)
			}
			requested := make(chan uint32, 1)
			go func() {
				for {
					packets, _, err := rtpSender.ReadRTCP()
					if err != nil {
						return
					}
					for _, packet := range packets {
						if request, ok := packet.(*rtcp.RapidResynchronizationRequest); ok {
							select {
							case requested <- request.MediaSSRC:
							default:
							}
						}
					}
				}
			}()
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
			data := make([]byte, size)
			copy(data, []byte{0, 0, 0, 0x9d, 1, 0x2a, 64, 0, 32, 0, 0})
			packetizer := rtp.NewPacketizer(1200, 96, 123, &codecs.VP8Payloader{}, rtp.NewFixedSequencer(1), 90000)
			var timestamp uint32
			for index, packet := range packetizer.Packetize(data, 3600) {
				timestamp = packet.Timestamp
				// Chromium paces detailed pictures in bursts. A short quiet gap
				// before the final marker must not flush an incomplete picture.
				if size == 40*1024 && index > 0 && index%8 == 0 {
					time.Sleep(25 * time.Millisecond)
				}
				if err = track.WriteRTP(packet); err != nil {
					t.Fatal(err)
				}
			}
			var sourceSSRC uint32
			select {
			case sourceSSRC = <-requested:
			case <-ctx.Done():
				t.Fatal("collector did not request the source clock on first RTP")
			}
			select {
			case <-packets:
				t.Fatal("collector invented a presentation timestamp before the source clock arrived")
			case <-time.After(50 * time.Millisecond):
			}
			// An isolated paused frame must survive clock establishment. Mapping it
			// one second after collector creation distinguishes source time from arrival.
			at := collector.started.Add(time.Second)
			ntp := uint64(at.Unix()+2208988800)<<32 | uint64(at.Nanosecond())<<32/1_000_000_000
			if err := sender.WriteRTCP([]rtcp.Packet{&rtcp.SenderReport{SSRC: sourceSSRC, NTPTime: ntp, RTPTime: timestamp}}); err != nil {
				t.Fatal(err)
			}
			select {
			case p := <-packets:
				if p.Header.TimestampUS < 999999 || p.Header.TimestampUS > 1000000 {
					t.Fatalf("source timestamp = %d, want 1000000 us", p.Header.TimestampUS)
				}
				if !bytes.Equal(p.Data, data) {
					t.Fatalf("incomplete frame: %d of %d bytes", len(p.Data), len(data))
				}
				if !p.Header.Keyframe || p.Header.Width != 64 || p.Header.Height != 32 {
					t.Fatalf("invalid last picture: %#v", p.Header)
				}
			case <-ctx.Done():
				t.Fatal("the last picture was retained until another source frame arrived")
			}
		})
	}
}

func TestCollectorRejectsUnboundIdentity(t *testing.T) {
	if _, err := NewCollector(Scope{Target: "target"}, func(*Track) {}); err == nil {
		t.Fatal("unbound collector admitted")
	}
}

func TestCollectorPreservesCaptureClockChangesBetweenSenderReports(t *testing.T) {
	const uri = "http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time"
	engine := &webrtc.MediaEngine{}
	if err := engine.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	if err := engine.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: uri}, webrtc.RTPCodecTypeAudio); err != nil {
		t.Fatal(err)
	}
	sender, err := webrtc.NewAPI(webrtc.WithMediaEngine(engine), webrtc.WithInterceptorRegistry(&interceptor.Registry{})).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer sender.Close()
	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus}, "audio", "source")
	if err != nil {
		t.Fatal(err)
	}
	rtpSender, err := sender.AddTrack(track)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	delivered := make(chan Packet, 8)
	collector, err := NewCollector(Scope{Target: "t", View: "v", Stream: "s", Node: 1}, func(track *Track) {
		go func() {
			for {
				packet, err := track.Next(ctx)
				if err != nil {
					return
				}
				delivered <- packet
			}
		}()
	})
	if err != nil {
		t.Fatal(err)
	}
	defer collector.Close()
	// The old collector can establish the initial mapping, but no later report
	// reveals the capture-device clock change carried by the third packet.
	go func() {
		for {
			packets, _, err := rtpSender.ReadRTCP()
			if err != nil {
				return
			}
			for _, packet := range packets {
				if request, ok := packet.(*rtcp.RapidResynchronizationRequest); ok {
					ntp := rtp.NewAbsCaptureTimeExtension(collector.started.Add(time.Second)).Timestamp
					_ = sender.WriteRTCP([]rtcp.Packet{&rtcp.SenderReport{SSRC: request.MediaSSRC, NTPTime: ntp, RTPTime: 7000}})
				}
			}
		}
	}()
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
	var extensionID uint8
	for _, extension := range rtpSender.GetParameters().HeaderExtensions {
		if extension.URI == uri {
			extensionID = uint8(extension.ID)
		}
	}
	if extensionID == 0 {
		t.Fatal("collector did not negotiate the source capture clock")
	}
	for index, want := range []int64{1000000, 1020000, 1240000, 1260000} {
		packet := &rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: uint16(index + 1), Timestamp: 7000 + uint32(index)*960, Marker: true}, Payload: []byte{0xf8, 0xff, 0xfe}}
		if index == 0 || index == 2 {
			extension, err := rtp.NewAbsCaptureTimeExtension(collector.started.Add(time.Duration(want) * time.Microsecond)).Marshal()
			if err != nil {
				t.Fatal(err)
			}
			if err = packet.SetExtension(extensionID, extension); err != nil {
				t.Fatal(err)
			}
		}
		if err = track.WriteRTP(packet); err != nil {
			t.Fatal(err)
		}
		select {
		case got := <-delivered:
			if got.Header.TimestampUS < want-1 || got.Header.TimestampUS > want {
				t.Fatalf("packet %d capture time = %d, want %d us without another sender report", index, got.Header.TimestampUS, want)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}
