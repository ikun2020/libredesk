// Package iplocation reads Simplified Chinese locations from a local IPDB file.
package iplocation

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/netip"
	"os"
	"slices"
	"strings"
	"unicode/utf8"
)

const (
	headerSize      = 4
	nodeSize        = 8
	maxFileSize     = 128 << 20
	maxMetadataSize = 64 << 10
	ipv4            = 1
	ipv6            = 2
)

// Database is immutable and can be shared across requests.
type Database struct {
	data      []byte
	nodeCount uint32
	ipVersion int
	fields    []int
}

// Open loads the standard QQWry IPDB file once for in-memory lookups.
func Open(path string) (*Database, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() <= headerSize || info.Size() > maxFileSize {
		return nil, errors.New("invalid IPDB file size or type")
	}
	var header [headerSize]byte
	if _, err := io.ReadFull(file, header[:]); err != nil {
		return nil, err
	}
	metadataSize := int64(binary.BigEndian.Uint32(header[:]))
	if metadataSize == 0 || metadataSize > maxMetadataSize || metadataSize >= info.Size()-headerSize {
		return nil, errors.New("invalid IPDB metadata length")
	}
	metadata := make([]byte, metadataSize)
	if _, err := io.ReadFull(file, metadata); err != nil {
		return nil, err
	}
	var meta struct {
		NodeCount uint32         `json:"node_count"`
		TotalSize int            `json:"total_size"`
		IPVersion int            `json:"ip_version"`
		Languages map[string]int `json:"languages"`
		Fields    []string       `json:"fields"`
	}
	if err := json.Unmarshal(metadata, &meta); err != nil {
		return nil, err
	}
	if int64(meta.TotalSize) != info.Size()-headerSize-metadataSize || meta.NodeCount == 0 ||
		uint64(meta.NodeCount)*nodeSize >= uint64(meta.TotalSize) || meta.IPVersion&(ipv4|ipv6) == 0 {
		return nil, errors.New("invalid IPDB trie size or IP version")
	}
	cn, ok := meta.Languages["CN"]
	if !ok || cn < 0 || cn > (1<<16)-len(meta.Fields) || !slices.Contains(meta.Fields, "country_name") {
		return nil, errors.New("IPDB file needs Simplified Chinese location fields")
	}
	var fields []int
	for _, name := range []string{"country_name", "region_name", "city_name", "district_name"} {
		if index := slices.Index(meta.Fields, name); index >= 0 {
			fields = append(fields, cn+index)
		}
	}
	data := make([]byte, meta.TotalSize)
	if _, err := io.ReadFull(file, data); err != nil {
		return nil, err
	}
	return &Database{data: data, nodeCount: meta.NodeCount, ipVersion: meta.IPVersion, fields: fields}, nil
}

// Lookup returns the available geographic fields for a public IP address.
func (db *Database) Lookup(ip string) string {
	if db == nil {
		return ""
	}
	addr, err := netip.ParseAddr(ip)
	if err != nil || addr.Zone() != "" {
		return ""
	}
	addr = addr.Unmap()
	if !addr.IsGlobalUnicast() || addr.IsPrivate() {
		return ""
	}
	version := ipv6
	if addr.Is4() {
		version = ipv4
	}
	if db.ipVersion&version == 0 {
		return ""
	}

	// IPDB stores IPv4 ranges under the IPv4-mapped IPv6 prefix.
	var node uint32
	bits := addr.As16()
	for i := 0; i < len(bits)*8 && node < db.nodeCount; i++ {
		branch := (bits[i/8] >> (7 - i%8)) & 1
		offset := int(node)*nodeSize + int(branch)*4
		node = binary.BigEndian.Uint32(db.data[offset:])
	}
	// nodeCount is the empty leaf. Higher values are offsets into the data area.
	if node <= db.nodeCount {
		return ""
	}
	offset := uint64(db.nodeCount)*nodeSize + uint64(node-db.nodeCount)
	if offset+2 > uint64(len(db.data)) {
		return ""
	}
	size := uint64(binary.BigEndian.Uint16(db.data[offset:]))
	if offset+2+size > uint64(len(db.data)) {
		return ""
	}
	record := db.data[offset+2 : offset+2+size]
	if !utf8.Valid(record) {
		return ""
	}
	values := strings.Split(string(record), "\t")
	var region []string
	for _, field := range db.fields {
		if field >= len(values) {
			return ""
		}
		value := strings.TrimSpace(values[field])
		switch value {
		case "IANA", "CZ88.NET", "保留地址", "局域网", "本机地址":
			return ""
		case "", "-", "未知":
			continue
		}
		if !slices.Contains(region, value) {
			region = append(region, value)
		}
	}
	return strings.Join(region, " ")
}
