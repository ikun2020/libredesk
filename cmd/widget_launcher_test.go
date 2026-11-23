package main

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"

	"github.com/abhinavxd/libredesk/internal/inbox/channel/livechat"
	"github.com/knadh/stuffbin"
	"github.com/valyala/fasthttp"
	"github.com/zerodha/fastglue"
)

func TestChatLauncherLogoDefaults(t *testing.T) {
	for _, tc := range []struct {
		name      string
		light     string
		dark      string
		wantLight string
		wantDark  string
	}{
		{"both default", "", "", defaultLauncherLogoPath, defaultLauncherLogoPath},
		{"dark custom", "", "https://example.com/dark.png", defaultLauncherLogoPath, "https://example.com/dark.png"},
		{"light custom", "https://example.com/light.png", "", "https://example.com/light.png", defaultLauncherLogoPath},
	} {
		t.Run(tc.name, func(t *testing.T) {
			config := livechat.Config{
				Branding: livechat.BrandingSet{
					Light: livechat.Branding{Launcher: livechat.BrandingLauncher{LogoURL: tc.light}},
					Dark:  livechat.Branding{Launcher: livechat.BrandingLauncher{LogoURL: tc.dark}},
				},
			}
			ctx := &fasthttp.RequestCtx{}
			ctx.SetUserValue(ctxWidgetConfig, config)
			if err := handleGetChatLauncherSettings(&fastglue.Request{RequestCtx: ctx}); err != nil {
				t.Fatal(err)
			}

			var response struct {
				Data struct {
					Branding livechat.BrandingSet
				}
			}
			if err := json.Unmarshal(ctx.Response.Body(), &response); err != nil {
				t.Fatal(err)
			}
			if response.Data.Branding.Light.Launcher.LogoURL != tc.wantLight ||
				response.Data.Branding.Dark.Launcher.LogoURL != tc.wantDark {
				t.Errorf("unexpected launcher branding: %+v", response.Data.Branding)
			}
		})
	}
}

func TestServeDefaultLauncherLogo(t *testing.T) {
	const portrait = "../static/public/launcher-logo.jpg"
	const original = "/static/public/launcher-logo.png"
	fs, err := stuffbin.NewLocalFS("/",
		portrait+":"+defaultLauncherLogoPath,
		".."+original+":"+original,
	)
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile(portrait)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{defaultLauncherLogoPath, original} {
		t.Run(path, func(t *testing.T) {
			ctx := &fasthttp.RequestCtx{}
			ctx.Request.SetRequestURI(path)
			if err := serveStaticFiles(&fastglue.Request{RequestCtx: ctx, Context: &App{fs: fs}}); err != nil {
				t.Fatal(err)
			}
			if got := ctx.Response.StatusCode(); got != fasthttp.StatusOK {
				t.Fatalf("status = %d, want %d", got, fasthttp.StatusOK)
			}
			cors := string(ctx.Response.Header.Peek("Access-Control-Allow-Origin"))
			if path != defaultLauncherLogoPath {
				if cors != "" {
					t.Errorf("unexpected CORS header on existing static asset: %q", cors)
				}
				return
			}
			if cors != "*" {
				t.Errorf("CORS header = %q, want *", cors)
			}
			if got := string(ctx.Response.Header.ContentType()); got != "image/jpeg" {
				t.Errorf("content type = %q, want image/jpeg", got)
			}
			if !bytes.Equal(ctx.Response.Body(), want) {
				t.Error("launcher response does not match the bundled portrait")
			}
		})
	}
}
