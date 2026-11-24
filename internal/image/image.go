// Package image provides utilities for processing image files, including
// retrieving image dimensions and creating thumbnails.
package image

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"image"
	"image/png"
	"io"

	"github.com/disintegration/imaging"
	"github.com/gabriel-vasile/mimetype"

	// Registers the WebP decoder with image.Decode, which imaging.Decode uses.
	_ "golang.org/x/image/webp"
)

const (
	// llmMaxDim caps an image's longest edge before it is sent to a vision model.
	llmMaxDim      = 1568
	llmJPEGQuality = 85
	// maxDecodePixels bounds width*height read from the header, blocking a small file that declares huge dimensions. 25 MP is ~100 MB of RGBA per agent worker.
	maxDecodePixels = 25_000_000
	// AvatarMaxDim caps an avatar's longest edge. The largest render is the 128px `lg` variant, at up to 4x DPI.
	AvatarMaxDim       = 512
	avatarJPEGQuality  = 85
	previewMaxDim      = 1600
	previewJPEGQuality = 84
)

var (
	Exts         = []string{"gif", "png", "jpg", "jpeg", "webp"}
	DefThumbSize = 150
	ThumbPrefix  = "thumb_"
)

// IsImageByContent returns true when the file's magic bytes identify it as one
// of the raster formats this package can decode. Used as a fallback when the
// filename has no extension or an unreliable one (e.g. attachments arriving
// through email without proper file extensions).
func IsImageByContent(r io.ReadSeeker) bool {
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return false
	}
	defer r.Seek(0, io.SeekStart)
	mtype, err := mimetype.DetectReader(r)
	if err != nil {
		return false
	}
	switch mtype.String() {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return true
	}
	return false
}

// GetDimensions returns the width and height of the image in the provided file without decoding the bitmap.
func GetDimensions(r io.Reader) (int, int, error) {
	cfg, _, err := image.DecodeConfig(r)
	if err != nil {
		return 0, 0, err
	}
	return cfg.Width, cfg.Height, nil
}

// CreateThumb generates a thumbnail of the given image file with the specified maximum dimension.
// The thumbnail's width will be resized to `thumbPxSize` while maintaining the aspect ratio.
func CreateThumb(thumbPxSize int, r io.ReadSeeker) (*bytes.Reader, error) {
	cfg, _, err := image.DecodeConfig(r)
	if err != nil {
		return nil, err
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > maxDecodePixels/cfg.Height {
		return nil, fmt.Errorf("invalid or too-large image dimensions %dx%d", cfg.Width, cfg.Height)
	}
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	img, err := imaging.Decode(r, imaging.AutoOrientation(true))
	if err != nil {
		return nil, err
	}

	thumb := imaging.Resize(img, thumbPxSize, 0, imaging.Lanczos)
	var out bytes.Buffer
	if err := imaging.Encode(&out, thumb, imaging.PNG); err != nil {
		return nil, err
	}

	return bytes.NewReader(out.Bytes()), nil
}

type Preview struct {
	Data        []byte
	ContentType string
}

// CreatePreview returns a smaller viewing rendition of a supported still image.
func CreatePreview(r io.ReadSeeker) (Preview, error) {
	cfg, format, err := image.DecodeConfig(r)
	if err != nil {
		return Preview{}, err
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > maxDecodePixels/cfg.Height {
		return Preview{}, fmt.Errorf("invalid or too-large image dimensions %dx%d", cfg.Width, cfg.Height)
	}
	if !isStillPreviewFormat(r, format) {
		return Preview{}, fmt.Errorf("unsupported preview image format %s", format)
	}
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return Preview{}, err
	}
	img, err := imaging.Decode(r, imaging.AutoOrientation(true))
	if err != nil {
		return Preview{}, err
	}
	view := imaging.Fit(img, previewMaxDim, previewMaxDim, imaging.Lanczos)
	var out bytes.Buffer
	contentType := "image/jpeg"
	if view.Opaque() {
		err = imaging.Encode(&out, view, imaging.JPEG, imaging.JPEGQuality(previewJPEGQuality))
	} else {
		contentType = "image/png"
		encoder := png.Encoder{CompressionLevel: png.BestSpeed}
		err = encoder.Encode(&out, view)
	}
	if err != nil {
		return Preview{}, err
	}
	return Preview{Data: out.Bytes(), ContentType: contentType}, nil
}

func isStillPreviewFormat(r io.ReadSeeker, format string) bool {
	switch format {
	case "jpeg":
		return true
	case "png":
		if _, err := r.Seek(8, io.SeekStart); err != nil {
			return false
		}
		var header [8]byte
		// APNG must put acTL before IDAT. Bound the number of chunks to examine.
		for range 256 {
			if _, err := io.ReadFull(r, header[:]); err != nil {
				return false
			}
			switch string(header[4:]) {
			case "acTL":
				return false
			case "IDAT":
				return true
			}
			if _, err := r.Seek(int64(binary.BigEndian.Uint32(header[:4]))+4, io.SeekCurrent); err != nil {
				return false
			}
		}
	case "webp":
		if _, err := r.Seek(12, io.SeekStart); err != nil {
			return false
		}
		var header [9]byte
		if _, err := io.ReadFull(r, header[:]); err == nil {
			// The first byte of a VP8X chunk contains its animation flag.
			return string(header[:4]) != "VP8X" || header[8]&0x02 == 0
		}
	}
	return false
}

// EncodeForLLM decodes an image, downscales its longest edge to at most llmMaxDim, re-encodes it as
// JPEG, and returns the base64 payload plus media type for a vision model request.
func EncodeForLLM(content []byte) (data string, mediaType string, err error) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(content))
	if err != nil {
		return "", "", err
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > maxDecodePixels/cfg.Height {
		return "", "", fmt.Errorf("invalid or too-large image dimensions %dx%d", cfg.Width, cfg.Height)
	}
	img, err := imaging.Decode(bytes.NewReader(content))
	if err != nil {
		return "", "", err
	}
	img = imaging.Fit(img, llmMaxDim, llmMaxDim, imaging.Lanczos)
	var out bytes.Buffer
	if err := imaging.Encode(&out, img, imaging.JPEG, imaging.JPEGQuality(llmJPEGQuality)); err != nil {
		return "", "", err
	}
	return base64.StdEncoding.EncodeToString(out.Bytes()), "image/jpeg", nil
}

// Downscale fits the image within maxDim on both edges and re-encodes it in its source format.
func Downscale(maxDim int, r io.ReadSeeker) (*bytes.Reader, error) {
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	cfg, format, err := image.DecodeConfig(r)
	if err != nil {
		return nil, err
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > maxDecodePixels/cfg.Height {
		return nil, fmt.Errorf("invalid or too-large image dimensions %dx%d", cfg.Width, cfg.Height)
	}
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	// Re-encoding drops EXIF, so bake in the rotation the browser would otherwise have honoured.
	img, err := imaging.Decode(r, imaging.AutoOrientation(true))
	if err != nil {
		return nil, err
	}

	img = imaging.Fit(img, maxDim, maxDim, imaging.Lanczos)

	var out bytes.Buffer
	switch format {
	case "jpeg":
		err = imaging.Encode(&out, img, imaging.JPEG, imaging.JPEGQuality(avatarJPEGQuality))
	case "gif":
		err = imaging.Encode(&out, img, imaging.GIF)
	default:
		err = imaging.Encode(&out, img, imaging.PNG)
	}
	if err != nil {
		return nil, err
	}
	return bytes.NewReader(out.Bytes()), nil
}
