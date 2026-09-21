package media

import (
	"bytes"
	"encoding/binary"
	"io"
	"testing"
)

func fixturePacket() Packet {
	return Packet{Header: Header{Version: 1, Target: "target", View: "view", Stream: "stream", Node: 1, Track: "video", Codec: "vp8", TimestampUS: 20000, DurationUS: 40000, Keyframe: true, Width: 640, Height: 360}, Data: []byte{0, 1, 2, 3}}
}

func TestPacketRoundTripThroughFragmentedReader(t *testing.T) {
	p := fixturePacket()
	var wire bytes.Buffer
	if err := WritePacket(&wire, p); err != nil {
		t.Fatal(err)
	}
	got, err := ReadPacket(&fragmentedReader{wire.Bytes()})
	if err != nil {
		t.Fatal(err)
	}
	if got.Header.Target != p.Header.Target || got.Header.TimestampUS != p.Header.TimestampUS || !bytes.Equal(got.Data, p.Data) {
		t.Fatalf("round trip changed packet: %#v", got.Header)
	}
}

func TestPacketRejectsLengthsBeforeReadingPayload(t *testing.T) {
	var prefix [4]byte
	binary.BigEndian.PutUint32(prefix[:], MaxHeaderBytes+1)
	if _, err := ReadPacket(bytes.NewReader(prefix[:])); err == nil {
		t.Fatal("oversized header admitted")
	}
	for _, body := range []string{
		`{"version":1,"target":"target","view":"view","stream":"stream","node":1,"track":"video","codec":"vp8","bytes":2147483647}`,
		`{"version":1,"target":"target","view":"view","stream":"stream","node":1,"track":"video","codec":"vp8","bytes":1,"cookies":"secret"}`,
	} {
		binary.BigEndian.PutUint32(prefix[:], uint32(len(body)))
		if _, err := ReadPacket(bytes.NewReader(append(prefix[:], []byte(body)...))); err == nil || err == io.EOF || err == io.ErrUnexpectedEOF {
			t.Fatalf("invalid header reached payload read: %v", err)
		}
	}
}

func TestPacketRejectsInvalidIdentityAndDimensions(t *testing.T) {
	for _, mutate := range []func(*Packet){
		func(p *Packet) { p.Header.View = "" },
		func(p *Packet) { p.Header.Width = 100000 },
		func(p *Packet) { p.Header.TimestampUS = -1 },
		func(p *Packet) { p.Data = nil },
		func(p *Packet) { p.Header.Codec = "unknown" },
	} {
		p := fixturePacket()
		mutate(&p)
		if err := WritePacket(io.Discard, p); err == nil {
			t.Fatal("invalid packet admitted")
		}
	}
}

type fragmentedReader struct{ b []byte }

func (r *fragmentedReader) Read(p []byte) (int, error) {
	if len(r.b) == 0 {
		return 0, io.EOF
	}
	n := min(3, len(p), len(r.b))
	copy(p, r.b[:n])
	r.b = r.b[n:]
	return n, nil
}
