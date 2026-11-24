package main

import (
	"os"
	"sync"

	"github.com/abhinavxd/libredesk/internal/image"
	mmodels "github.com/abhinavxd/libredesk/internal/media/models"
)

const (
	previewCacheEntries = 16
	previewMaxBytes     = 1 << 20
)

type previewCacheEntry struct {
	path    string
	preview image.Preview
}

// mediaPreviewCache bounds retained bytes and concurrent full-size image decodes.
// Callers must authorize access to the original before checking this cache.
type mediaPreviewCache struct {
	mu       sync.Mutex
	encoding sync.Mutex
	entries  [previewCacheEntries]previewCacheEntry
	next     int
}

func (c *mediaPreviewCache) lookup(path string) (image.Preview, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, entry := range c.entries {
		if entry.path == path {
			return entry.preview, true
		}
	}
	return image.Preview{}, false
}

func (c *mediaPreviewCache) load(path, contentType string) image.Preview {
	if preview, found := c.lookup(path); found {
		return preview
	}
	if !c.encoding.TryLock() {
		return image.Preview{}
	}
	defer c.encoding.Unlock()
	if preview, found := c.lookup(path); found {
		return preview
	}

	file, err := os.Open(path)
	if err != nil {
		return image.Preview{}
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || !mmodels.CanPreviewImage(contentType, int(info.Size())) {
		return image.Preview{}
	}
	preview, err := image.CreatePreview(file)
	if err != nil || len(preview.Data) > previewMaxBytes || int64(len(preview.Data)) >= info.Size() {
		preview = image.Preview{}
	}
	c.mu.Lock()
	c.entries[c.next] = previewCacheEntry{path: path, preview: preview}
	c.next = (c.next + 1) % len(c.entries)
	c.mu.Unlock()
	return preview
}
