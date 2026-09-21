// Package media receives source-element media on the source host and exposes
// bounded encoded packets for an embedding host's authenticated byte streams.
package media

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

const (
	WireVersion      = 1
	MaxHeaderBytes   = 16 * 1024
	MaxPacketBytes   = 2 * 1024 * 1024
	StreamChunkBytes = 16 * 1024
)

var ErrInvalidPacket = errors.New("invalid media packet")

// Header carries presentation identity, never credentials or source addresses.
// TimestampUS is relative to the source subscription's monotonic clock.
type Header struct {
	Version     int    `json:"version"`
	Target      string `json:"target"`
	View        string `json:"view"`
	Stream      string `json:"stream"`
	Node        int64  `json:"node"`
	Track       string `json:"track"`
	Codec       string `json:"codec"`
	TimestampUS int64  `json:"timestamp_us"`
	DurationUS  int64  `json:"duration_us"`
	Keyframe    bool   `json:"keyframe"`
	Width       int    `json:"width,omitempty"`
	Height      int    `json:"height,omitempty"`
	Description string `json:"description,omitempty"`
	Bytes       int    `json:"bytes"`
}

type Packet struct {
	Header Header
	Data   []byte
}

func validID(s string) bool {
	return len(s) > 0 && len(s) <= 80 && !strings.ContainsAny(s, "\x00\r\n")
}

func (h Header) Validate() error {
	if h.Version != WireVersion || !validID(h.Target) || !validID(h.View) || !validID(h.Stream) || h.Node <= 0 || h.Node > 9007199254740991 || h.Bytes <= 0 || h.Bytes > MaxPacketBytes || h.TimestampUS < 0 || h.TimestampUS > 9007199254740991 || h.DurationUS < 0 || h.DurationUS > 1_000_000 || len(h.Description) > 8192 {
		return ErrInvalidPacket
	}
	switch h.Track {
	case "video":
		if h.Codec != "vp8" && h.Codec != "h264" {
			return ErrInvalidPacket
		}
	case "audio":
		if h.Codec != "opus" || h.Width != 0 || h.Height != 0 {
			return ErrInvalidPacket
		}
		return nil
	case "canvas":
		if h.Codec != "webp" || !h.Keyframe {
			return ErrInvalidPacket
		}
	default:
		return ErrInvalidPacket
	}
	if h.Width < 1 || h.Height < 1 || h.Width > 8192 || h.Height > 8192 {
		return ErrInvalidPacket
	}
	return nil
}

func WritePacket(w io.Writer, p Packet) error {
	p.Header.Bytes = len(p.Data)
	if err := p.Header.Validate(); err != nil {
		return err
	}
	header, err := json.Marshal(p.Header)
	if err != nil {
		return err
	}
	if len(header) > MaxHeaderBytes {
		return ErrInvalidPacket
	}
	var prefix [4]byte
	binary.BigEndian.PutUint32(prefix[:], uint32(len(header)))
	for _, b := range [][]byte{prefix[:], header, p.Data} {
		for len(b) > 0 {
			part := b[:min(len(b), StreamChunkBytes)]
			n, err := w.Write(part)
			if n < 0 || n > len(part) {
				return io.ErrShortWrite
			}
			if err != nil {
				return err
			}
			if n == 0 {
				return io.ErrShortWrite
			}
			b = b[n:]
		}
	}
	return nil
}

func ReadPacket(r io.Reader) (Packet, error) {
	var p Packet
	var prefix [4]byte
	if _, err := io.ReadFull(r, prefix[:]); err != nil {
		return p, err
	}
	n := binary.BigEndian.Uint32(prefix[:])
	if n == 0 || n > MaxHeaderBytes {
		return p, ErrInvalidPacket
	}
	header := make([]byte, n)
	if _, err := io.ReadFull(r, header); err != nil {
		return p, err
	}
	d := json.NewDecoder(bytes.NewReader(header))
	d.DisallowUnknownFields()
	if err := d.Decode(&p.Header); err != nil {
		return p, ErrInvalidPacket
	}
	if d.Decode(new(any)) != io.EOF {
		return p, ErrInvalidPacket
	}
	if err := p.Header.Validate(); err != nil {
		return p, err
	}
	p.Data = make([]byte, p.Header.Bytes)
	if _, err := io.ReadFull(r, p.Data); err != nil {
		return Packet{}, err
	}
	return p, nil
}
