package iplocation

import (
	"encoding/binary"
	"encoding/json"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
)

// The fixtures contain synthetic records and the documented IPDB wire format.
type fixtureMetadata struct {
	NodeCount uint32         `json:"node_count"`
	IPVersion int            `json:"ip_version"`
	TotalSize int            `json:"total_size"`
	Languages map[string]int `json:"languages"`
	Fields    []string       `json:"fields"`
}

type fixtureBuilder struct {
	nodes   [][2]int
	records []string
}

func newFixture() *fixtureBuilder {
	return &fixtureBuilder{nodes: [][2]int{{-1, -1}}}
}

func (f *fixtureBuilder) add(prefix, record string) {
	leaf := -2 - len(f.records)
	f.records = append(f.records, record)
	network := netip.MustParsePrefix(prefix)
	address := network.Addr().As16()
	bitCount := network.Bits()
	if network.Addr().Is4() {
		bitCount += 96
	}
	if bitCount == 0 {
		f.nodes[0] = [2]int{leaf, leaf}
		return
	}
	node := 0
	for bit := 0; bit < bitCount; bit++ {
		branch := int((address[bit/8] >> (7 - bit%8)) & 1)
		if bit == bitCount-1 {
			f.nodes[node][branch] = leaf
			return
		}
		if f.nodes[node][branch] == -1 {
			f.nodes[node][branch] = len(f.nodes)
			f.nodes = append(f.nodes, [2]int{-1, -1})
		}
		node = f.nodes[node][branch]
	}
}

func (f *fixtureBuilder) parts() (fixtureMetadata, []byte) {
	count := len(f.nodes)
	data := make([]byte, count*8+1)
	var records []uint32
	for _, record := range f.records {
		records = append(records, uint32(count+len(data)-count*8))
		data = binary.BigEndian.AppendUint16(data, uint16(len(record)))
		data = append(data, record...)
	}
	for i, branches := range f.nodes {
		for branch, link := range branches {
			pointer := uint32(count)
			if link >= 0 {
				pointer = uint32(link)
			} else if link < -1 {
				pointer = records[-link-2]
			}
			binary.BigEndian.PutUint32(data[i*8+branch*4:], pointer)
		}
	}
	return fixtureMetadata{
		NodeCount: uint32(count), IPVersion: 3, TotalSize: len(data),
		Languages: map[string]int{"CN": 0},
		Fields:    []string{"country_name", "region_name", "city_name", "district_name", "isp_domain"},
	}, data
}

func fixtureFile(t *testing.T, meta fixtureMetadata, data []byte) string {
	t.Helper()
	header, err := json.Marshal(meta)
	if err != nil {
		t.Fatal(err)
	}
	contents := binary.BigEndian.AppendUint32(nil, uint32(len(header)))
	contents = append(contents, header...)
	contents = append(contents, data...)
	return writeFixture(t, contents)
}

func writeFixture(t *testing.T, contents []byte) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "synthetic.ipdb")
	if err := os.WriteFile(file, contents, 0600); err != nil {
		t.Fatal(err)
	}
	return file
}

func openFixture(t *testing.T, meta fixtureMetadata, data []byte) *Database {
	t.Helper()
	db, err := Open(fixtureFile(t, meta, data))
	if err != nil {
		t.Fatalf("opening synthetic database: %v", err)
	}
	return db
}

func TestLookupIPv4AndIPv6Locations(t *testing.T) {
	fixture := newFixture()
	fixture.add("8.8.8.0/24", " 中国 \t广东省\t深圳市\t南山区　\tISP must be omitted")
	fixture.add("2001:4860:4860::/48", "中国\t北京市\t北京市\t海淀区\tIPv6 ISP")
	meta, data := fixture.parts()
	db := openFixture(t, meta, data)
	for _, test := range []struct{ ip, want string }{
		{"8.8.7.255", ""},
		{"8.8.8.0", "中国 广东省 深圳市 南山区"},
		{"8.8.8.8", "中国 广东省 深圳市 南山区"},
		{"8.8.8.255", "中国 广东省 深圳市 南山区"},
		{"8.8.9.0", ""},
		{"2001:4860:4860::", "中国 北京市 海淀区"},
		{"2001:4860:4860::8888", "中国 北京市 海淀区"},
		{"2001:4860:4860:ffff:ffff:ffff:ffff:ffff", "中国 北京市 海淀区"},
		{"2001:4860:4861::1", ""},
	} {
		t.Run(test.ip, func(t *testing.T) {
			if got := db.Lookup(test.ip); got != test.want {
				t.Fatalf("Lookup(%q) = %q, want %q", test.ip, got, test.want)
			}
		})
	}
}

func TestLookupUsesChineseOffsetAndFieldNames(t *testing.T) {
	fixture := newFixture()
	fixture.add("8.8.8.0/24", "ISP\tUnited States\tEnglish city\tEnglish province\tEnglish district\t运营商\t中国\t深圳市\t广东省\t南山区")
	meta, data := fixture.parts()
	meta.Fields = []string{"isp_domain", "country_name", "city_name", "region_name", "district_name"}
	meta.Languages = map[string]int{"EN": 0, "CN": 5}
	if got := openFixture(t, meta, data).Lookup("8.8.8.8"); got != "中国 广东省 深圳市 南山区" {
		t.Fatalf("Chinese location = %q", got)
	}
	meta.Fields = []string{"country_name"}
	meta.Languages = map[string]int{"CN": 6}
	if got := openFixture(t, meta, data).Lookup("8.8.8.8"); got != "中国" {
		t.Fatalf("country-only database location = %q", got)
	}
}

func TestLookupFiltersPlaceholdersAndNonPublicIPs(t *testing.T) {
	for _, test := range []struct{ record, want string }{
		{"中国\t未知\t-\t\tISP", "中国"},
		{"IANA\t保留\t\t\tISP", ""},
		{"CZ88.NET\t\t\t\tISP", ""},
		{"局域网\t\t\t\tISP", ""},
		{"本机地址\t\t\t\tISP", ""},
		{"保留地址\t\t\t\tISP", ""},
		{"未知\t-\t\t\tISP", ""},
	} {
		fixture := newFixture()
		fixture.add("8.8.8.0/24", test.record)
		meta, data := fixture.parts()
		if got := openFixture(t, meta, data).Lookup("8.8.8.8"); got != test.want {
			t.Errorf("record %q displayed as %q, want %q", test.record, got, test.want)
		}
	}
	fixture := newFixture()
	fixture.add("::/0", "中国\t广东省\t深圳市\t\tISP")
	meta, data := fixture.parts()
	db := openFixture(t, meta, data)
	for _, ip := range []string{
		"", "invalid", "8.8.8.8:80", "0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.1.1",
		"172.16.1.1", "192.168.1.1", "224.0.0.1", "255.255.255.255", "::", "::1",
		"fc00::1", "fe80::1", "ff02::1", "2001:4860::1%eth0", "::ffff:192.168.1.1",
	} {
		if got := db.Lookup(ip); got != "" {
			t.Errorf("non-public or invalid IP %q displayed as %q", ip, got)
		}
	}
	meta.IPVersion = 2
	if got := openFixture(t, meta, data).Lookup("8.8.8.8"); got != "" {
		t.Errorf("IPv6-only database returned IPv4 location %q", got)
	}
	meta.IPVersion = 1
	if got := openFixture(t, meta, data).Lookup("2001:4860::1"); got != "" {
		t.Errorf("IPv4-only database returned IPv6 location %q", got)
	}
	var missing *Database
	if got := missing.Lookup("8.8.8.8"); got != "" {
		t.Errorf("nil database returned %q", got)
	}
}

func TestLookupMalformedLeavesReturnEmpty(t *testing.T) {
	fixture := newFixture()
	fixture.add("::/0", "中国\t广东省\t深圳市\t\tISP")
	for _, test := range []string{"missing leaf", "past data", "truncated length", "truncated record", "cyclic node", "invalid UTF-8", "missing fields"} {
		t.Run(test, func(t *testing.T) {
			meta, data := fixture.parts()
			pointer := meta.NodeCount + 1
			record := int(meta.NodeCount)*8 + 1
			switch test {
			case "missing leaf":
				pointer = meta.NodeCount
			case "past data":
				pointer = ^uint32(0)
			case "truncated length":
				pointer = meta.NodeCount + uint32(len(data)-int(meta.NodeCount)*8-1)
			case "truncated record":
				binary.BigEndian.PutUint16(data[record:], 65535)
			case "cyclic node":
				pointer = 0
			case "invalid UTF-8":
				data[record+2] = 0xff
			case "missing fields":
				binary.BigEndian.PutUint16(data[record:], 6)
			}
			binary.BigEndian.PutUint32(data[:4], pointer)
			binary.BigEndian.PutUint32(data[4:8], pointer)
			if got := openFixture(t, meta, data).Lookup("8.8.8.8"); got != "" {
				t.Fatalf("malformed leaf returned %q", got)
			}
		})
	}
}

func TestOpenRejectsMalformedMetadata(t *testing.T) {
	fixture := newFixture()
	fixture.add("::/0", "中国\t广东省\t深圳市\t\tISP")
	for _, test := range []string{"zero nodes", "node bounds", "wrong total size", "unsupported version", "missing CN", "negative CN", "oversized CN", "missing country"} {
		t.Run(test, func(t *testing.T) {
			meta, data := fixture.parts()
			switch test {
			case "zero nodes":
				meta.NodeCount = 0
			case "node bounds":
				meta.NodeCount = ^uint32(0)
			case "wrong total size":
				meta.TotalSize++
			case "unsupported version":
				meta.IPVersion = 0
			case "missing CN":
				meta.Languages = map[string]int{"EN": 0}
			case "negative CN":
				meta.Languages["CN"] = -1
			case "oversized CN":
				meta.Languages["CN"] = 65536
			case "missing country":
				meta.Fields = []string{"isp_domain"}
			}
			if db, err := Open(fixtureFile(t, meta, data)); err == nil || db != nil {
				t.Fatalf("malformed metadata accepted, database=%v, err=%v", db, err)
			}
		})
	}
	for _, data := range [][]byte{nil, {0, 0, 0}, {0, 0, 0, 0, 0}, {0xff, 0xff, 0xff, 0xff, 0}, {0, 0, 0, 2, '{', '!', 0}} {
		if db, err := Open(writeFixture(t, data)); err == nil || db != nil {
			t.Fatalf("invalid file accepted, database=%v, err=%v", db, err)
		}
	}
	if db, err := Open(filepath.Join(t.TempDir(), "missing.ipdb")); err == nil || db != nil {
		t.Fatalf("missing file accepted, database=%v, err=%v", db, err)
	}
	if db, err := Open(t.TempDir()); err == nil || db != nil {
		t.Fatalf("directory accepted, database=%v, err=%v", db, err)
	}
}
