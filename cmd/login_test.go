package main

import (
	"testing"

	"github.com/valyala/fasthttp"
	"github.com/zerodha/fastglue"
)

func TestRenewSessionRequiresCSRFAndBrowserAuth(t *testing.T) {
	app := newValidatorTestApp(t)
	newRequest := func() *fastglue.Request {
		ctx := &fasthttp.RequestCtx{}
		ctx.Init(&fasthttp.Request{}, nil, nil)
		ctx.Request.SetRequestURI(testAppBaseURL + "/api/v1/auth/renew")
		ctx.Request.Header.SetMethod(fasthttp.MethodPost)
		return &fastglue.Request{RequestCtx: ctx, Context: app}
	}

	t.Run("browser request without CSRF token", func(t *testing.T) {
		r := newRequest()
		if err := auth(handleRenewSession)(r); err != nil {
			t.Fatal(err)
		}
		if got := r.RequestCtx.Response.StatusCode(); got != fasthttp.StatusForbidden {
			t.Fatalf("status = %d, want %d", got, fasthttp.StatusForbidden)
		}
	})

	t.Run("API key authentication", func(t *testing.T) {
		r := newRequest()
		r.RequestCtx.SetUserValue("auth_method", authMethodAPIKey)
		if err := handleRenewSession(r); err != nil {
			t.Fatal(err)
		}
		if got := r.RequestCtx.Response.StatusCode(); got != fasthttp.StatusForbidden {
			t.Fatalf("status = %d, want %d", got, fasthttp.StatusForbidden)
		}
	})
}
