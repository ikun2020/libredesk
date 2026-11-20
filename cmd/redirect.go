package main

import (
	"fmt"
	"strings"

	"github.com/valyala/fasthttp"
	"github.com/zerodha/fastglue"
)

// redirectAppURI keeps application redirects on the browser's current origin.
// RedirectURI/Redirect resolve relative paths against the backend request URL,
// which can be HTTP behind an HTTPS reverse proxy. A root-relative Location
// preserves the public scheme and host without trusting forwarded headers.
func redirectAppURI(r *fastglue.Request, uri string, args map[string]any) error {
	u := fasthttp.AcquireURI()
	defer fasthttp.ReleaseURI(u)
	if err := u.Parse(nil, []byte(uri)); err != nil {
		return err
	}
	for key, value := range args {
		u.QueryArgs().Add(key, fmt.Sprint(value))
	}

	// Match RedirectURI's handling of next: discard any scheme/authority and
	// require exactly one leading slash, so it cannot become an external URL.
	location := "/" + strings.TrimLeft(string(u.RequestURI()), "/")
	if hash := u.Hash(); len(hash) > 0 {
		location += "#" + string(hash)
	}
	r.RequestCtx.Response.Header.Set("Location", location)
	r.RequestCtx.SetStatusCode(fasthttp.StatusFound)
	return nil
}
