package media

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/logging"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
)

func TestCollectorKeepsInterceptorsOffControlPipe(t *testing.T) {
	if os.Getenv("FLOEBROWSER_TEST_LOG_PIPE") != "1" {
		executable, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		cmd := exec.CommandContext(t.Context(), executable, "-test.run=^TestCollectorKeepsInterceptorsOffControlPipe$", "-test.timeout=10s")
		cmd.Env = append(os.Environ(), "FLOEBROWSER_TEST_LOG_PIPE=1")
		var stdout, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		if err := cmd.Run(); err != nil {
			t.Fatalf("collector fixture failed: %v\n%s\n%s", err, &stdout, &stderr)
		}
		if stderr.Len() != 0 {
			t.Fatalf("library diagnostics corrupt the helper control pipe: %s", &stderr)
		}
		return
	}

	// Only the production collector may write to the captured control pipe. The
	// independent source peer uses an explicitly silent logger for every layer.
	logger := logging.NewDefaultLoggerFactory()
	logger.Writer = io.Discard
	var settings webrtc.SettingEngine
	settings.LoggerFactory = logger
	engine := &webrtc.MediaEngine{}
	if err := engine.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptorsWithOptions(engine, registry, webrtc.WithInterceptorLoggerFactory(logger)); err != nil {
		t.Fatal(err)
	}
	sender, err := webrtc.NewAPI(webrtc.WithMediaEngine(engine), webrtc.WithSettingEngine(settings), webrtc.WithInterceptorRegistry(registry)).NewPeerConnection(webrtc.Configuration{})
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
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	received := make(chan error, 1)
	collector, err := NewCollector(Scope{Target: "t", View: "v", Stream: "s", Node: 1}, func(track *Track) {
		go func() {
			_, err := track.Next(ctx)
			received <- err
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
	if err := sender.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	answer, err := collector.Answer(ctx, offer.SDP)
	if err != nil {
		t.Fatal(err)
	}
	if err := sender.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-connected:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var extensionID uint8
	for _, extension := range rtpSender.GetParameters().HeaderExtensions {
		if extension.URI == "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01" {
			extensionID = uint8(extension.ID)
		}
	}
	if extensionID == 0 {
		t.Fatal("transport feedback must be negotiated for the failure fixture")
	}
	packetizer := rtp.NewPacketizer(1200, 96, 123, &codecs.VP8Payloader{}, rtp.NewFixedSequencer(1), 90000)
	for _, packet := range packetizer.Packetize([]byte{0, 0, 0, 0x9d, 1, 0x2a, 64, 0, 32, 0, 0}, 3600) {
		if err := packet.SetExtension(extensionID, []byte{0, 1}); err != nil {
			t.Fatal(err)
		}
		if err := track.WriteRTP(packet); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case err := <-received:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	// A navigation can close the native transport while a queued TWCC response
	// is still due. Keep the collector alive so that response takes its error path.
	if err := collector.peer.SCTP().Transport().ICETransport().Stop(); err != nil {
		t.Fatal(err)
	}
	if err := collector.peer.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: 123}}); err == nil {
		t.Fatal("the native transport must reject feedback after it stops")
	}
	time.Sleep(350 * time.Millisecond)
}
