package main

import (
	"bytes"
	"encoding/json"
	stdimage "image"
	"image/png"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	mmodels "github.com/abhinavxd/libredesk/internal/media/models"
	"github.com/valyala/fasthttp"
	"github.com/zerodha/fastglue"
)

func TestPrepareImageUploadAllowsOversizedImageWithoutThumbnail(t *testing.T) {
	imageData := []byte{'G', 'I', 'F', '8', '9', 'a', 0x10, 0x27, 0x88, 0x13, 0x00, 0x00, 0x00}

	prepared, err := prepareImageUpload(bytes.NewReader(imageData))
	if err != nil {
		t.Fatal(err)
	}
	if prepared.thumbnail != nil {
		t.Fatal("expected thumbnail to be skipped")
	}
	if prepared.thumbnailErr == nil {
		t.Fatal("expected thumbnail error to be retained")
	}

	var meta struct {
		Width  int `json:"width"`
		Height int `json:"height"`
	}
	if err := json.Unmarshal(prepared.meta, &meta); err != nil {
		t.Fatal(err)
	}
	if meta.Width != 10_000 || meta.Height != 5_000 {
		t.Fatalf("dimensions = %dx%d, want 10000x5000", meta.Width, meta.Height)
	}
}

func TestServeMediaFilePreviewsExistingImageAndPreservesOriginal(t *testing.T) {
	const uuid = "0b7a3c1e-2f4d-4b8a-9c6e-1d2f3a4b5c6e"
	dir := t.TempDir()
	path := filepath.Join(dir, uuid)
	img := stdimage.NewNRGBA(stdimage.Rect(0, 0, 1900, 1000))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i] = 180
		img.Pix[i+3] = 255
	}
	var input bytes.Buffer
	encoder := png.Encoder{CompressionLevel: png.NoCompression}
	if err := encoder.Encode(&input, img); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, input.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ko.Set("upload.fs.upload_path", dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ko.Delete("upload.fs.upload_path") })

	app := &App{}
	app.consts.Store(&constants{UploadProvider: "fs"})
	media := &mmodels.Media{UUID: uuid, ContentType: "image/png", Filename: "original.png", Size: input.Len(), Private: true}
	serve := func(t *testing.T, query string) *fasthttp.Response {
		t.Helper()
		req := &fastglue.Request{RequestCtx: &fasthttp.RequestCtx{}, Context: app}
		req.RequestCtx.Request.SetRequestURI("/uploads/" + uuid + query)
		if err := serveMediaFile(req, app, uuid, media); err != nil {
			t.Fatal(err)
		}
		return &req.RequestCtx.Response
	}
	view := serve(t, "?preview=1")
	cfg, format, err := stdimage.DecodeConfig(bytes.NewReader(view.Body()))
	if err != nil || format != "jpeg" || cfg.Width != 1600 || cfg.Height >= 1000 {
		t.Fatalf("invalid preview: size=%dx%d format=%s err=%v", cfg.Width, cfg.Height, format, err)
	}
	if len(view.Body()) >= input.Len() || string(view.Header.ContentType()) != "image/jpeg" ||
		!strings.HasPrefix(string(view.Header.Peek("Cache-Control")), "private,") {
		t.Fatal("preview must be smaller, correctly typed, and privately cached")
	}
	t.Logf("compressed preview uses %d bytes instead of %d", len(view.Body()), input.Len())
	if !bytes.Equal(view.Body(), serve(t, "?preview=1").Body()) {
		t.Fatal("repeated preview changed")
	}
	if got, err := os.ReadFile(path); err != nil || !bytes.Equal(input.Bytes(), got) {
		t.Fatal("preview changed the stored original")
	}
	t.Run("inline and download return original bytes", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("fasthttp holds originals in its global open-file cache, preventing temporary cleanup on Windows")
		}
		if !bytes.Equal(input.Bytes(), serve(t, "").Body()) {
			t.Fatal("plain image request changed the original bytes")
		}
		download := serve(t, "?preview=1&download=1")
		if !bytes.Equal(input.Bytes(), download.Body()) || !strings.HasPrefix(string(download.Header.Peek("Content-Disposition")), "attachment") {
			t.Fatal("explicit download must select the original attachment")
		}
	})
}

func TestServeMediaFileSandboxesDownloads(t *testing.T) {
	const uuid = "0b7a3c1e-2f4d-4b8a-9c6e-1d2f3a4b5c6d"
	dir := t.TempDir()
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)
	if err := os.WriteFile(filepath.Join(dir, uuid), svg, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ko.Set("upload.fs.upload_path", dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ko.Delete("upload.fs.upload_path") })

	app := &App{}
	app.consts.Store(&constants{UploadProvider: "fs"})

	tests := []struct {
		name            string
		contentType     string
		download        bool
		wantType        string
		wantDisposition string
		wantSandbox     bool
	}{
		{"svg", "image/svg+xml", false, "image/svg+xml", "attachment", true},
		{"svg with bad param", "image/svg+xml; x", false, "image/svg+xml", "attachment", true},
		{"other xml image", "image/x+xml", false, "image/x+xml", "attachment", true},
		{"unparseable", "text/plain,image/svg+xml", false, "application/octet-stream", "attachment", true},
		{"html", "text/html", false, "text/html", "attachment", true},
		{"png", "image/png", false, "image/png", "inline", false},
		{"png forced download", "image/png", true, "image/png", "attachment", true},
		{"video", "video/mp4", false, "video/mp4", "inline", false},
		{"video forced download", "video/mp4", true, "video/mp4", "attachment", true},
		{"pdf", "application/pdf", false, "application/pdf", "inline", false},
		{"pdf forced download", "application/pdf", true, "application/pdf", "attachment", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := &fastglue.Request{RequestCtx: &fasthttp.RequestCtx{}, Context: app}
			if tt.download {
				req.RequestCtx.Request.SetRequestURI("/uploads/" + uuid + "?download=1")
			}
			media := &mmodels.Media{ContentType: tt.contentType, Filename: "file", Private: true}
			if err := serveMediaFile(req, app, uuid, media); err != nil {
				t.Fatal(err)
			}

			h := &req.RequestCtx.Response.Header
			if got := string(h.ContentType()); got != tt.wantType {
				t.Fatalf("Content-Type = %q, want %q", got, tt.wantType)
			}
			if got := string(h.Peek("Content-Disposition")); !strings.HasPrefix(got, tt.wantDisposition) {
				t.Fatalf("Content-Disposition = %q, want %s", got, tt.wantDisposition)
			}
			if got := string(h.Peek("Content-Security-Policy")) == "sandbox"; got != tt.wantSandbox {
				t.Fatalf("sandboxed = %v, want %v", got, tt.wantSandbox)
			}
		})
	}
}
