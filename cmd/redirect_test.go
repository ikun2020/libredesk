package main

import (
	"net/url"
	"strings"
	"testing"
	"time"

	auth_ "github.com/abhinavxd/libredesk/internal/auth"
	amodels "github.com/abhinavxd/libredesk/internal/auth/models"
	"github.com/abhinavxd/libredesk/internal/testutil"
	"github.com/abhinavxd/libredesk/internal/user"
	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/valyala/fasthttp"
	"github.com/zerodha/fastglue"
)

func newRedirectTestRequest(app *App, path string) *fastglue.Request {
	ctx := &fasthttp.RequestCtx{}
	ctx.Init(&fasthttp.Request{}, nil /** remoteAddr **/, nil /** logger **/)
	ctx.Request.SetRequestURI(path)
	ctx.Request.Header.SetHost("desk.example.com")
	return &fastglue.Request{RequestCtx: ctx, Context: app}
}

func newRedirectTestApp(t *testing.T) *App {
	t.Helper()
	app := newValidatorTestApp(t)
	mr := miniredis.RunT(t)
	rd := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rd.Close() })
	var err error
	app.auth, err = auth_.New(auth_.Config{SessionLifetime: time.Hour}, app.i18n, rd, app.lo, nil /** dialControl **/)
	if err != nil {
		t.Fatal(err)
	}
	return app
}

func assertSameOriginRedirect(t *testing.T, r *fastglue.Request) *url.URL {
	t.Helper()
	if status := r.RequestCtx.Response.StatusCode(); status != fasthttp.StatusFound {
		t.Fatalf("status = %d, want 302", status)
	}
	location := string(r.RequestCtx.Response.Header.Peek("Location"))
	if !strings.HasPrefix(location, "/") || strings.HasPrefix(location, "//") || strings.ContainsAny(location, "\\\r\n") {
		t.Fatalf("Location is not a safe root-relative URL: %q", location)
	}
	target, err := url.Parse(location)
	if err != nil {
		t.Fatal(err)
	}
	// The public browser is HTTPS even though the backend request uses HTTP.
	publicURL, _ := url.Parse(testAppBaseURL + "/inboxes/assigned")
	resolved := publicURL.ResolveReference(target)
	if resolved.Scheme != "https" || resolved.Host != publicURL.Host {
		t.Fatalf("redirect leaves the public origin: %s", resolved)
	}
	return target
}

func TestAuthPageRedirectPreservesPublicOrigin(t *testing.T) {
	app := newRedirectTestApp(t)
	for _, forwarded := range []string{"", "https", "http", "https, http", "untrusted"} {
		t.Run("forwarded="+forwarded, func(t *testing.T) {
			r := newRedirectTestRequest(app, "/inboxes/assigned?status=open&search=a%2Bb")
			r.RequestCtx.Request.Header.Set("X-Forwarded-Proto", forwarded)
			if string(r.RequestCtx.URI().Scheme()) != "http" {
				t.Fatal("test must simulate an HTTP backend behind TLS termination")
			}
			if err := authPage(func(*fastglue.Request) error {
				t.Fatal("unauthenticated request reached protected page")
				return nil
			})(r); err != nil {
				t.Fatal(err)
			}
			target := assertSameOriginRedirect(t, r)
			if target.Path != "/" || target.Query().Get("next") != "/inboxes/assigned?status=open&search=a%2Bb" {
				t.Fatalf("login redirect lost the requested inbox: %s", target)
			}
		})
	}
}

func TestRedirectAppURIKeepsLocalPathQueryAndFragment(t *testing.T) {
	for _, tc := range []struct {
		name string
		uri  string
		want string
	}{
		{"local", "/inboxes/assigned?status=open#reply", "/inboxes/assigned?status=open#reply"},
		{"absolute", "https://outside.example/inboxes/assigned?status=open#reply", "/inboxes/assigned?status=open#reply"},
		{"protocol relative", "//outside.example/inboxes/assigned?status=open#reply", "/inboxes/assigned?status=open#reply"},
		{"duplicate slash", "///outside.example//inboxes", "/outside.example/inboxes"},
		{"escaped slash", "/%2f%2foutside.example/inboxes", "/outside.example/inboxes"},
		{"backslash", "/\\outside.example/inboxes", "/%5Coutside.example/inboxes"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newRedirectTestRequest(nil, "/")
			if err := redirectAppURI(r, tc.uri, nil); err != nil {
				t.Fatal(err)
			}
			assertSameOriginRedirect(t, r)
			if got := string(r.RequestCtx.Response.Header.Peek("Location")); got != tc.want {
				t.Fatalf("Location = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestRedirectAppURIRejectsControlCharacters(t *testing.T) {
	for _, uri := range []string{"/inboxes\r\nLocation: https://outside.example", "/inboxes\tassigned"} {
		r := newRedirectTestRequest(nil, "/")
		if err := redirectAppURI(r, uri, nil); err == nil {
			t.Fatalf("accepted a control character in %q", uri)
		}
		if location := r.RequestCtx.Response.Header.Peek("Location"); len(location) != 0 {
			t.Fatalf("invalid target wrote Location: %q", location)
		}
	}
}

func TestLoginErrorRedirectPreservesNextAndError(t *testing.T) {
	r := newRedirectTestRequest(nil, "/oidc/callback/1")
	next := "/inboxes/assigned?search=hello%20world&status=open#reply"
	if err := redirectLoginError(r, oidcErrSessionExpired, next); err != nil {
		t.Fatal(err)
	}
	target := assertSameOriginRedirect(t, r)
	if target.Path != "/" || target.Query().Get("error") != oidcErrSessionExpired || target.Query().Get("next") != next {
		t.Fatalf("OIDC error redirect lost its parameters: %s", target)
	}
}

func TestNotAuthPageRedirectPreservesPublicOrigin(t *testing.T) {
	db := testutil.NewDB(t, "cmd_redirect")
	var agentID int
	if err := db.Get(&agentID, `INSERT INTO users (type, email, first_name, last_name, enabled) VALUES ('agent', 'redirect@example.com', 'Agent', '', true) RETURNING id`); err != nil {
		t.Fatal(err)
	}
	app := newRedirectTestApp(t)
	var err error
	app.user, err = user.New(app.i18n, user.Opts{DB: db, Lo: app.lo})
	if err != nil {
		t.Fatal(err)
	}
	login := newRedirectTestRequest(app, "/")
	if err := app.auth.SaveSession(amodels.User{ID: agentID, Email: "redirect@example.com"}, login); err != nil {
		t.Fatal(err)
	}
	var cookie fasthttp.Cookie
	cookie.SetKey("libredesk_session")
	if !login.RequestCtx.Response.Header.Cookie(&cookie) {
		t.Fatal("missing session cookie")
	}
	for _, next := range []string{"", "/inboxes/assigned?status=open#reply", "https://outside.example/inboxes/assigned?status=open#reply"} {
		t.Run("next="+next, func(t *testing.T) {
			r := newRedirectTestRequest(app, "/?next="+url.QueryEscape(next))
			r.RequestCtx.Request.Header.SetCookie("libredesk_session", string(cookie.Value()))
			if err := notAuthPage(func(*fastglue.Request) error {
				t.Fatal("authenticated user reached login page")
				return nil
			})(r); err != nil {
				t.Fatal(err)
			}
			target := assertSameOriginRedirect(t, r)
			if target.Path != "/inboxes/assigned" {
				t.Fatalf("redirect path = %q", target.Path)
			}
			if next != "" && (target.Query().Get("status") != "open" || target.Fragment != "reply") {
				t.Fatalf("redirect lost inbox query or fragment: %s", target)
			}
		})
	}
}
