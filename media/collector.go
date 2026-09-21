package media

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/bluenviron/mediacommon/v2/pkg/codecs/h264"
	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/logging"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media/samplebuilder"
)

type Scope struct {
	Target string `json:"target"`
	View   string `json:"view"`
	Stream string `json:"stream"`
	Node   int64  `json:"node"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

// Track is one encoded track. Its queue never waits for a remote consumer.
type Track struct {
	Kind, Codec string
	queue       *Queue
	requestKey  func()
}

func (t *Track) Next(ctx context.Context) (Packet, error) {
	for {
		packet, err := t.queue.Next(ctx)
		if !errors.Is(err, ErrKeyframeRequired) {
			return packet, err
		}
		t.RequestKeyframe()
	}
}
func (t *Track) RequestKeyframe() {
	if t.requestKey != nil {
		t.requestKey()
	}
}

type Collector struct {
	peer      *webrtc.PeerConnection
	mux       *ice.UDPMuxDefault
	scope     Scope
	started   time.Time
	onTrack   func(*Track)
	mu        sync.Mutex
	tracks    []*Track
	closed    bool
	closeOnce sync.Once
}

// NewCollector binds a fresh source-host loopback socket. ICE-lite prevents
// outgoing checks to source-supplied candidates. It is never a remote carrier.
func NewCollector(scope Scope, onTrack func(*Track)) (*Collector, error) {
	if !validID(scope.Target) || !validID(scope.View) || !validID(scope.Stream) || scope.Node <= 0 || scope.Node > 1<<53-1 || scope.Width < 0 || scope.Height < 0 || scope.Width > 8192 || scope.Height > 8192 || onTrack == nil {
		return nil, ErrInvalidPacket
	}
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		return nil, err
	}
	// Source media metadata and library diagnostics never enter application
	// control/media pipes or host debug logs.
	logger := logging.NewDefaultLoggerFactory()
	logger.Writer = io.Discard
	mux := ice.NewUDPMuxDefault(ice.UDPMuxParams{UDPConn: conn, Logger: logger.NewLogger("source-ice")})
	var settings webrtc.SettingEngine
	settings.LoggerFactory = logger
	settings.SetLite(true)
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	settings.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	settings.SetICEUDPMux(mux)
	settings.SetSCTPMaxMessageSize(64 * 1024)
	engine := &webrtc.MediaEngine{}
	for _, codec := range []webrtc.RTPCodecParameters{
		{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000, RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}}}, PayloadType: 96},
		{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f", RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}}}, PayloadType: 102},
		{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1"}, PayloadType: 111},
	} {
		kind := webrtc.RTPCodecTypeVideo
		if codec.MimeType == webrtc.MimeTypeOpus {
			kind = webrtc.RTPCodecTypeAudio
		}
		if err = engine.RegisterCodec(codec, kind); err != nil {
			_ = mux.Close()
			return nil, err
		}
	}
	registry := &interceptor.Registry{}
	if err = webrtc.RegisterDefaultInterceptors(engine, registry); err != nil {
		_ = mux.Close()
		return nil, err
	}
	peer, err := webrtc.NewAPI(webrtc.WithMediaEngine(engine), webrtc.WithSettingEngine(settings), webrtc.WithInterceptorRegistry(registry)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		_ = mux.Close()
		return nil, err
	}
	c := &Collector{peer: peer, mux: mux, scope: scope, started: time.Now(), onTrack: onTrack}
	peer.OnTrack(c.receiveTrack)
	peer.OnDataChannel(c.receiveCanvas)
	return c, nil
}

func (c *Collector) Answer(ctx context.Context, offer string) (string, error) {
	if len(offer) == 0 || len(offer) > 48000 {
		return "", ErrInvalidPacket
	}
	// The sender initiates checks against our loopback candidate. No remote
	// candidate, STUN URL or relay address is accepted as a dial destination.
	lines := strings.Split(offer, "\r\n")
	filtered := lines[:0]
	for _, line := range lines {
		if !strings.HasPrefix(line, "a=candidate:") && !strings.HasPrefix(line, "a=remote-candidates:") {
			filtered = append(filtered, line)
		}
	}
	if err := c.peer.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: strings.Join(filtered, "\r\n")}); err != nil {
		return "", errors.New("source media offer rejected")
	}
	answer, err := c.peer.CreateAnswer(nil)
	if err != nil {
		return "", err
	}
	gathered := webrtc.GatheringCompletePromise(c.peer)
	if err = c.peer.SetLocalDescription(answer); err != nil {
		return "", err
	}
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case <-gathered:
	}
	return c.peer.LocalDescription().SDP, nil
}

func (c *Collector) addTrack(kind, codec string, request func()) *Track {
	t := &Track{Kind: kind, Codec: codec, queue: NewQueue(QueueLimits{}), requestKey: request}
	c.mu.Lock()
	if c.closed || len(c.tracks) >= 3 {
		c.mu.Unlock()
		t.queue.Close()
		return nil
	}
	c.tracks = append(c.tracks, t)
	c.mu.Unlock()
	c.onTrack(t)
	return t
}

func (c *Collector) header(kind, codec string) Header {
	return Header{Version: WireVersion, Target: c.scope.Target, View: c.scope.View, Stream: c.scope.Stream, Node: c.scope.Node, Track: kind, Codec: codec, Width: c.scope.Width, Height: c.scope.Height}
}

func (c *Collector) receiveTrack(remote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
	codec := remote.Codec()
	kind, name := "video", "vp8"
	var depacketizer rtp.Depacketizer = &codecs.VP8Packet{}
	switch strings.ToLower(codec.MimeType) {
	case "video/vp8":
	case "video/h264":
		name = "h264"
		depacketizer = &codecs.H264Packet{}
	case "audio/opus":
		kind, name = "audio", "opus"
		depacketizer = &codecs.OpusPacket{}
	default:
		return
	}
	var keyMu sync.Mutex
	var lastKey time.Time
	requestKey := func() {
		keyMu.Lock()
		defer keyMu.Unlock()
		if time.Since(lastKey) < 100*time.Millisecond {
			return
		}
		lastKey = time.Now()
		_ = c.peer.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(remote.SSRC())}})
	}
	track := c.addTrack(kind, name, requestKey)
	if track == nil {
		return
	}
	defer track.queue.Close()
	clock := &trackClock{started: c.started, rate: int64(codec.ClockRate)}
	go func() {
		for {
			packets, _, err := receiver.ReadRTCP()
			if err != nil {
				return
			}
			for _, p := range packets {
				if report, ok := p.(*rtcp.SenderReport); ok {
					clock.report(report.RTPTime, report.NTPTime)
				}
			}
		}
	}()
	build := samplebuilder.New(16, depacketizer, codec.ClockRate, samplebuilder.WithMaxTimeDelay(100*time.Millisecond))
	header := c.header(kind, name)
	if kind == "audio" {
		header.Width, header.Height = 0, 0
	}
	for {
		packet, _, err := remote.ReadRTP()
		if err != nil {
			var timeout net.Error
			if !errors.As(err, &timeout) || !timeout.Timeout() {
				return
			}
			// The final paused picture has no following RTP timestamp. Flush
			// complete access units after a bounded source-local reorder window.
			build.Flush()
			_ = remote.SetReadDeadline(time.Time{})
		} else {
			build.Push(packet)
			_ = remote.SetReadDeadline(time.Now().Add(20 * time.Millisecond))
		}
		for sample := build.Pop(); sample != nil; sample = build.Pop() {
			if len(sample.Data) == 0 || len(sample.Data) > MaxPacketBytes {
				requestKey()
				continue
			}
			header.TimestampUS = clock.timestamp(sample.PacketTimestamp)
			header.DurationUS = min(max(sample.Duration.Microseconds(), 0), 1_000_000)
			header.Keyframe = kind == "audio"
			if name == "vp8" {
				header.Keyframe = sample.Data[0]&1 == 0
				if header.Keyframe {
					if len(sample.Data) < 10 || string(sample.Data[3:6]) != "\x9d\x01\x2a" {
						requestKey()
						continue
					}
					header.Width = int(binary.LittleEndian.Uint16(sample.Data[6:8]) & 0x3fff)
					header.Height = int(binary.LittleEndian.Uint16(sample.Data[8:10]) & 0x3fff)
				}
			}
			if name == "h264" {
				header.Keyframe = false
				var au h264.AnnexB
				if au.Unmarshal(sample.Data) != nil {
					requestKey()
					continue
				}
				for _, nalu := range au {
					if len(nalu) == 0 {
						continue
					}
					switch nalu[0] & 31 {
					case 5:
						header.Keyframe = true
					case 7:
						var sps h264.SPS
						if sps.Unmarshal(nalu) == nil {
							header.Width, header.Height = sps.Width(), sps.Height()
						}
					}
				}
			}
			if sample.PrevDroppedPackets > 0 && kind == "video" {
				track.queue.Invalidate()
			}
			header.Bytes = len(sample.Data)
			if header.Validate() != nil {
				requestKey()
				continue
			}
			if track.queue.Push(Packet{Header: header, Data: sample.Data}) {
				requestKey()
			}
		}
	}
}

func (c *Collector) Close() error {
	var err error
	c.closeOnce.Do(func() {
		c.mu.Lock()
		c.closed = true
		for _, t := range c.tracks {
			t.queue.Close()
		}
		c.mu.Unlock()
		err = c.peer.Close()
		_ = c.mux.Close()
	})
	return err
}

func (c *Collector) RequestKeyframe() {
	c.mu.Lock()
	tracks := append([]*Track(nil), c.tracks...)
	c.mu.Unlock()
	for _, t := range tracks {
		if t.Kind == "video" {
			t.RequestKeyframe()
		}
	}
}

type trackClock struct {
	mu      sync.Mutex
	started time.Time
	rate    int64
	rtp     uint32
	at      time.Time
	set     bool
	last    int64
}

func (c *trackClock) report(rtpTime uint32, ntp uint64) {
	seconds := int64(ntp>>32) - 2208988800
	nanos := int64((ntp & 0xffffffff) * 1_000_000_000 >> 32)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.rtp = rtpTime
	c.at = time.Unix(seconds, nanos)
	c.set = true
}
func (c *trackClock) timestamp(value uint32) int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.set {
		c.set = true
		c.rtp = value
		c.at = time.Now()
	}
	stamp := c.at.Sub(c.started).Microseconds() + int64(int32(value-c.rtp))*1_000_000/c.rate
	c.last = max(c.last, stamp, 0)
	return c.last
}
