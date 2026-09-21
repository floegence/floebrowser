package media

import (
	"encoding/binary"
	"time"

	"github.com/pion/webrtc/v4"
)

const canvasChunkBytes = 16 * 1024

type canvasFrame struct {
	id, width, height uint32
	bytes             []byte
	chunks            map[uint32]bool
}
type canvasAssembler struct {
	latest uint32
	frame  *canvasFrame
}

func (a *canvasAssembler) receive(packet []byte) *canvasFrame {
	if len(packet) <= 20 || len(packet) > 20+canvasChunkBytes {
		return nil
	}
	id, width, height, total, offset := binary.BigEndian.Uint32(packet), binary.BigEndian.Uint32(packet[4:]), binary.BigEndian.Uint32(packet[8:]), binary.BigEndian.Uint32(packet[12:]), binary.BigEndian.Uint32(packet[16:])
	length := uint32(len(packet) - 20)
	if id == 0 || width == 0 || height == 0 || width > 8192 || height > 8192 || total == 0 || total > 1024*1024 || offset%canvasChunkBytes != 0 || offset >= total || length != min(uint32(canvasChunkBytes), total-offset) {
		return nil
	}
	if id < a.latest || id == a.latest && a.frame == nil {
		return nil
	}
	if id > a.latest {
		a.latest = id
		a.frame = &canvasFrame{id: id, width: width, height: height, bytes: make([]byte, total), chunks: map[uint32]bool{}}
	}
	f := a.frame
	if f == nil || f.width != width || f.height != height || len(f.bytes) != int(total) {
		return nil
	}
	copy(f.bytes[offset:], packet[20:])
	f.chunks[offset] = true
	if len(f.chunks) != int((total+canvasChunkBytes-1)/canvasChunkBytes) {
		return nil
	}
	a.frame = nil
	if len(f.bytes) < 12 || string(f.bytes[:4]) != "RIFF" || string(f.bytes[8:12]) != "WEBP" {
		return nil
	}
	return f
}

func (c *Collector) receiveCanvas(channel *webrtc.DataChannel) {
	if channel.Label() != "floe-canvas-v1" {
		_ = channel.Close()
		return
	}
	track := c.addTrack("canvas", "webp", nil)
	if track == nil {
		_ = channel.Close()
		return
	}
	var assembler canvasAssembler
	channel.OnMessage(func(message webrtc.DataChannelMessage) {
		if message.IsString {
			return
		}
		frame := assembler.receive(message.Data)
		if frame == nil {
			return
		}
		header := c.header("canvas", "webp")
		header.Width, header.Height = int(frame.width), int(frame.height)
		header.Keyframe = true
		header.TimestampUS = time.Since(c.started).Microseconds()
		track.queue.Push(Packet{Header: header, Data: frame.bytes})
	})
	channel.OnClose(func() { track.queue.Close() })
}
