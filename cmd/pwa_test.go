package main

import (
	"strings"
	"testing"

	auth_ "github.com/abhinavxd/libredesk/internal/auth"
	"github.com/knadh/stuffbin"
	"github.com/valyala/fasthttp"
	"github.com/zerodha/fastglue"
)

func TestFrontendAssetCacheControl(t *testing.T) {
	fs, err := stuffbin.NewLocalFS("/",
		"../frontend/apps/main/index.html:frontend/dist/main/index.html",
		"../frontend/public/sw.js:frontend/dist/main/assets/inbox-f-8PC_5B.js",
		"../static/public/static/fonts.css:frontend/dist/main/assets/index-DvIVWM_S.css",
		"../frontend/public/sw.js:frontend/dist/main/assets/loader.js",
		"../static/public/static/fonts.css:frontend/dist/main/assets/theme.css",
		"../frontend/public/images/logo.png:frontend/dist/main/assets/logo-f-8PC_5B.png",
		"../frontend/public/sw.js:frontend/dist/main/images/inbox-f-8PC_5B.js",
		"../frontend/public/sw.js:frontend/dist/main/sw.js",
		"../static/widget.js:static/widget.js",
	)
	if err != nil {
		t.Fatalf("creating test filesystem: %v", err)
	}
	app := newValidatorTestApp(t)
	app.fs = fs
	app.auth = &auth_.Auth{}
	const longCache = "public, max-age=31536000, immutable"

	for _, tc := range []struct {
		path    string
		handler fastglue.FastRequestHandler
		cache   string
		status  int
	}{
		{"/assets/inbox-f-8PC_5B.js", serveFrontendStaticFiles, longCache, fasthttp.StatusOK},
		{"/assets/index-DvIVWM_S.css", serveFrontendStaticFiles, longCache, fasthttp.StatusOK},
		{"/assets/loader.js", serveFrontendStaticFiles, "", fasthttp.StatusOK},
		{"/assets/theme.css", serveFrontendStaticFiles, "", fasthttp.StatusOK},
		{"/assets/logo-f-8PC_5B.png", serveFrontendStaticFiles, "", fasthttp.StatusOK},
		{"/images/inbox-f-8PC_5B.js", serveFrontendStaticFiles, "", fasthttp.StatusOK},
		{"/assets/missing-ABCD1234.js", serveFrontendStaticFiles, "", fasthttp.StatusNotFound},
		{"/", serveIndexPage, "no-store, no-cache, must-revalidate, post-check=0, pre-check=0", fasthttp.StatusOK},
		{"/widget.js", serveWidgetJS, "no-store, no-cache, must-revalidate, max-age=0", fasthttp.StatusOK},
		{"/sw.js", serveServiceWorker, "no-cache", fasthttp.StatusOK},
	} {
		t.Run(tc.path, func(t *testing.T) {
			ctx := &fasthttp.RequestCtx{}
			ctx.Request.SetRequestURI(tc.path)
			if err := tc.handler(&fastglue.Request{RequestCtx: ctx, Context: app}); err != nil {
				t.Fatalf("serving file: %v", err)
			}
			if got := ctx.Response.StatusCode(); got != tc.status {
				t.Errorf("status = %d, want %d", got, tc.status)
			}
			if got := string(ctx.Response.Header.Peek("Cache-Control")); got != tc.cache {
				t.Errorf("cache control = %q, want %q", got, tc.cache)
			}
		})
	}
}

func TestServePWAFiles(t *testing.T) {
	fs, err := stuffbin.NewLocalFS("/",
		"../frontend/public/manifest.webmanifest:frontend/dist/main/manifest.webmanifest",
		"../frontend/public/sw.js:frontend/dist/main/sw.js",
	)
	if err != nil {
		t.Fatalf("creating test filesystem: %v", err)
	}

	tests := []struct {
		name                 string
		handler              fastglue.FastRequestHandler
		contentType          string
		wantServiceWorkerHdr bool
	}{
		{"manifest", serveManifest, "application/manifest+json", false},
		{"service worker", serveServiceWorker, "application/javascript", true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ctx := &fasthttp.RequestCtx{}
			req := &fastglue.Request{RequestCtx: ctx, Context: &App{fs: fs}}
			if err := tc.handler(req); err != nil {
				t.Fatalf("serving file: %v", err)
			}
			if got := string(ctx.Response.Header.ContentType()); got != tc.contentType {
				t.Errorf("content type = %q, want %q", got, tc.contentType)
			}
			if got := string(ctx.Response.Header.Peek("Cache-Control")); got != "no-cache" {
				t.Errorf("cache control = %q, want no-cache", got)
			}
			if tc.wantServiceWorkerHdr && string(ctx.Response.Header.Peek("Service-Worker-Allowed")) != "/" {
				t.Error("service worker scope header is missing")
			}
			if strings.TrimSpace(string(ctx.Response.Body())) == "" {
				t.Error("response body is empty")
			}
		})
	}
}
