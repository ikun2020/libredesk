package main

import (
	"encoding/json"
	"os"
	"testing"

	oidcmodels "github.com/abhinavxd/libredesk/internal/oidc/models"
	"github.com/knadh/koanf/v2"
	"github.com/knadh/stuffbin"
	"github.com/valyala/fasthttp"
	"github.com/zerodha/fastglue"
)

func TestIncludeConfigLanguage(t *testing.T) {
	fs, err := stuffbin.NewLocalFS("/",
		"../i18n/en-US.json:i18n/en-US.json",
		"../i18n/zh-CN.json:i18n/zh-CN.json",
	)
	if err != nil {
		t.Fatal(err)
	}
	app := newValidatorTestApp(t)
	app.fs = fs
	for _, tt := range []struct {
		query string
		want  bool
	}{
		{query: ""},
		{query: "?include_language=false"},
		{query: "?include_language=true", want: true},
	} {
		t.Run(tt.query, func(t *testing.T) {
			ctx := &fasthttp.RequestCtx{}
			ctx.Request.SetRequestURI("/api/v1/config" + tt.query)
			settings := map[string]any{"app.lang": "zh-CN"}
			includeConfigLanguage(&fastglue.Request{RequestCtx: ctx, Context: app}, settings)

			encoded, err := json.Marshal(settings)
			if err != nil {
				t.Fatal(err)
			}
			var decoded map[string]json.RawMessage
			if err := json.Unmarshal(encoded, &decoded); err != nil {
				t.Fatal(err)
			}
			messages, ok := decoded["app.lang_messages"]
			if ok != tt.want {
				t.Fatalf("language messages present = %v, want %v", ok, tt.want)
			}
			if tt.want {
				var lang map[string]string
				if err := json.Unmarshal(messages, &lang); err != nil {
					t.Fatal(err)
				}
				if got := lang["globals.terms.loading"]; got != "加载中" {
					t.Errorf("loading label = %q, want the configured Chinese translation", got)
				}
			}
		})
	}
}

func TestIsLocalLoginEnabled(t *testing.T) {
	tests := []struct {
		name       string
		configured *bool
		providers  []oidcmodels.OIDC
		want       bool
	}{
		{name: "defaults to enabled", want: true},
		{name: "remains enabled when configured", configured: boolPointer(true), want: true},
		{name: "remains enabled without an enabled OIDC provider", configured: boolPointer(false), providers: []oidcmodels.OIDC{{Enabled: false}}, want: true},
		{name: "is disabled with an enabled OIDC provider", configured: boolPointer(false), providers: []oidcmodels.OIDC{{Enabled: true}}, want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ko.Delete(localLoginEnabledKey)
			if tt.configured != nil {
				if err := ko.Set(localLoginEnabledKey, *tt.configured); err != nil {
					t.Fatalf("set config: %v", err)
				}
			}
			t.Cleanup(func() { ko.Delete(localLoginEnabledKey) })

			if got := isLocalLoginEnabled(tt.providers); got != tt.want {
				t.Fatalf("isLocalLoginEnabled() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestClientIPHeaderConfig(t *testing.T) {
	tests := []struct {
		name       string
		railway    string
		configured string
		override   string
		want       string
	}{
		{name: "default", want: "X-Client-IP"},
		{name: "railway", railway: "environment-id", want: "X-Real-IP"},
		{name: "explicit header", configured: "CF-Connecting-IP", want: "CF-Connecting-IP"},
		{name: "explicit railway header", railway: "environment-id", configured: "X-Client-IP", want: "X-Client-IP"},
		{name: "environment override", railway: "environment-id", configured: "X-Client-IP", override: "CF-Connecting-IP", want: "CF-Connecting-IP"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("RAILWAY_ENVIRONMENT_ID", tt.railway)
			t.Setenv("LIBREDESK_APP__SERVER__CLIENT_IP_HEADER", tt.override)
			config := koanf.New(".")
			if err := config.Set("app.server.client_ip_header", tt.configured); err != nil {
				t.Fatal(err)
			}
			if tt.override == "" {
				if err := os.Unsetenv("LIBREDESK_APP__SERVER__CLIENT_IP_HEADER"); err != nil {
					t.Fatal(err)
				}
			}
			initConfig(config)
			if got := config.String("app.server.client_ip_header"); got != tt.want {
				t.Fatalf("client_ip_header = %q, want %q", got, tt.want)
			}
		})
	}
}

func boolPointer(value bool) *bool {
	return &value
}
