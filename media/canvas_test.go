package media

import (
	"encoding/binary"
	"testing"
)

func canvasChunk(id, offset, total, width uint32) []byte {
	size := min(uint32(canvasChunkBytes), total-offset)
	packet := make([]byte, 20+size)
	for i, v := range []uint32{id, width, 150, total, offset} {
		binary.BigEndian.PutUint32(packet[i*4:], v)
	}
	for i := range packet[20:] {
		packet[20+i] = byte(id)
	}
	if offset == 0 && size >= 12 {
		copy(packet[20:], "RIFF")
		copy(packet[28:], "WEBP")
	}
	return packet
}
func TestCanvasReordersDeduplicatesAndReplacesIncompletePictures(t *testing.T) {
	var a canvasAssembler
	total := uint32(canvasChunkBytes + 80)
	for _, data := range [][]byte{canvasChunk(1, canvasChunkBytes, total, 300), canvasChunk(1, canvasChunkBytes, total, 300), canvasChunk(2, 0, total, 300), canvasChunk(1, 0, total, 300)} {
		if a.receive(data) != nil {
			t.Fatal("incomplete or obsolete picture delivered")
		}
	}
	complete := a.receive(canvasChunk(2, canvasChunkBytes, total, 300))
	if complete == nil || complete.width != 300 || complete.height != 150 || len(complete.bytes) != int(total) || complete.bytes[len(complete.bytes)-1] != 2 {
		t.Fatal("complete picture not reconstructed")
	}
	if a.receive(canvasChunk(2, 0, total, 300)) != nil || a.receive(canvasChunk(2, canvasChunkBytes, total, 300)) != nil {
		t.Fatal("completed picture replayed")
	}
}
func TestCanvasRejectsMalformedSizeAndInconsistentDimensions(t *testing.T) {
	var a canvasAssembler
	for _, data := range [][]byte{make([]byte, 2), canvasChunk(1, 0, 1024*1024+1, 300), canvasChunk(1, 0, 32, 0), canvasChunk(1, 0, 32, 8193), canvasChunk(1, 1, 32, 300)} {
		if a.receive(data) != nil || a.frame != nil {
			t.Fatal("invalid packet allocated a canvas frame")
		}
	}
	if a.receive(canvasChunk(1, 0, canvasChunkBytes+32, 300)) != nil {
		t.Fatal("partial image delivered")
	}
	if a.receive(canvasChunk(1, canvasChunkBytes, canvasChunkBytes+32, 400)) != nil {
		t.Fatal("inconsistent dimensions accepted")
	}
	malformed := canvasChunk(2, 0, 32, 300)
	malformed[20] = 0
	if a.receive(malformed) != nil {
		t.Fatal("non-WebP data accepted")
	}
	if a.receive(canvasChunk(3, 0, 32, 300)) == nil {
		t.Fatal("malformed predecessor blocked a fresh valid image")
	}
}
