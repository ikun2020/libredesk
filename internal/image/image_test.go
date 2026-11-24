package image

import (
	"bytes"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"strings"
	"testing"
)

func encodePNG(t *testing.T, w, h int) *bytes.Reader {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return bytes.NewReader(buf.Bytes())
}

func TestGetDimensions(t *testing.T) {
	tests := []struct {
		name string
		data *bytes.Reader
		w, h int
	}{
		{"png", encodePNG(t, 300, 200), 300, 200},
	}

	var jbuf bytes.Buffer
	if err := jpeg.Encode(&jbuf, image.NewRGBA(image.Rect(0, 0, 640, 480)), nil); err != nil {
		t.Fatal(err)
	}
	tests = append(tests, struct {
		name string
		data *bytes.Reader
		w, h int
	}{"jpeg", bytes.NewReader(jbuf.Bytes()), 640, 480})

	var gbuf bytes.Buffer
	pimg := image.NewPaletted(image.Rect(0, 0, 12, 34), []color.Color{color.Black, color.White})
	if err := gif.Encode(&gbuf, pimg, nil); err != nil {
		t.Fatal(err)
	}
	tests = append(tests, struct {
		name string
		data *bytes.Reader
		w, h int
	}{"gif", bytes.NewReader(gbuf.Bytes()), 12, 34})

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w, h, err := GetDimensions(tt.data)
			if err != nil {
				t.Fatal(err)
			}
			if w != tt.w || h != tt.h {
				t.Fatalf("got %dx%d, want %dx%d", w, h, tt.w, tt.h)
			}
		})
	}
}

func TestGetDimensionsInvalid(t *testing.T) {
	if _, _, err := GetDimensions(bytes.NewReader([]byte("not an image"))); err == nil {
		t.Fatal("expected error for invalid data")
	}
}

func TestCreateThumb(t *testing.T) {
	thumb, err := CreateThumb(DefThumbSize, encodePNG(t, 400, 300))
	if err != nil {
		t.Fatal(err)
	}
	cfg, _, err := image.DecodeConfig(thumb)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Width != DefThumbSize {
		t.Fatalf("thumb width = %d, want %d", cfg.Width, DefThumbSize)
	}
	if cfg.Height <= 0 || cfg.Height > DefThumbSize {
		t.Fatalf("thumb height = %d, want (0, %d]", cfg.Height, DefThumbSize)
	}
}

func TestCreateThumbRejectsHugeDimensions(t *testing.T) {
	// A GIF header declaring 65535x65535 (4.3 gigapixels) with no pixel data:
	// DecodeConfig reads only the header, so the guard must fire before any decode.
	huge := []byte{'G', 'I', 'F', '8', '9', 'a', 0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00}
	_, err := CreateThumb(DefThumbSize, bytes.NewReader(huge))
	if err == nil {
		t.Fatal("expected error for image exceeding maxDecodePixels")
	}
	if !strings.Contains(err.Error(), "too-large") {
		t.Fatalf("expected the size guard to reject it, got: %v", err)
	}
}

func TestCreateThumbInvalid(t *testing.T) {
	if _, err := CreateThumb(DefThumbSize, bytes.NewReader([]byte("junk"))); err == nil {
		t.Fatal("expected error for invalid data")
	}
}

func TestCreatePreviewFitsOpaqueAndTransparentImages(t *testing.T) {
	for _, transparent := range []bool{false, true} {
		t.Run(map[bool]string{false: "opaque jpeg", true: "transparent png"}[transparent], func(t *testing.T) {
			img := image.NewNRGBA(image.Rect(0, 0, 2000, 1000))
			for i := 0; i < len(img.Pix); i += 4 {
				img.Pix[i] = 180
				if !transparent || i/4%2 == 0 {
					img.Pix[i+3] = 255
				}
			}
			var input bytes.Buffer
			if err := png.Encode(&input, img); err != nil {
				t.Fatal(err)
			}
			preview, err := CreatePreview(bytes.NewReader(input.Bytes()))
			if err != nil {
				t.Fatal(err)
			}
			cfg, format, err := image.DecodeConfig(bytes.NewReader(preview.Data))
			if err != nil {
				t.Fatal(err)
			}
			if cfg.Width != 1600 || cfg.Height != 800 {
				t.Fatalf("preview dimensions = %dx%d, want 1600x800", cfg.Width, cfg.Height)
			}
			want := "jpeg"
			if transparent {
				want = "png"
			}
			if format != want || preview.ContentType != "image/"+want {
				t.Fatalf("preview format = %s (%s), want %s", format, preview.ContentType, want)
			}
		})
	}
}

func TestCreatePreviewRejectsOversizedOrAnimatedImages(t *testing.T) {
	sources := [][]byte{
		{'G', 'I', 'F', '8', '9', 'a', 0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00},
	}
	// Animated PNG advertises acTL before the first IDAT, even when a decoder only sees the first frame.
	still := encodePNG(t, 64, 64)
	pngBytes := make([]byte, still.Len())
	if _, err := still.Read(pngBytes); err != nil {
		t.Fatal(err)
	}
	animationControl := []byte{0, 0, 0, 8, 'a', 'c', 'T', 'L', 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0}
	sources = append(sources, bytes.Join([][]byte{pngBytes[:33], animationControl, pngBytes[33:]}, nil))
	for _, source := range sources {
		if _, err := CreatePreview(bytes.NewReader(source)); err == nil {
			t.Fatal("expected preview rejection")
		}
	}
}
