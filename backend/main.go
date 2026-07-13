package main

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var httpClient = &http.Client{Timeout: 30 * time.Second}

var userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

func main() {
	if ua := os.Getenv("REDDIT_USER_AGENT"); ua != "" {
		userAgent = ua
	}
	addr := ":8080"
	if p := os.Getenv("PORT"); p != "" {
		addr = ":" + p
	}
	staticDir := os.Getenv("STATIC_DIR")
	if staticDir == "" {
		staticDir = "../frontend/dist"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/feed", handleFeed)
	mux.HandleFunc("GET /api/media", handleMedia)
	mux.Handle("GET /", spaHandler(staticDir))

	log.Printf("redditview listening on %s (static: %s)", addr, staticDir)
	log.Fatal(http.ListenAndServe(addr, mux))
}

// spaHandler serves the built frontend, falling back to index.html for
// paths that don't correspond to a file on disk.
func spaHandler(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := filepath.Join(dir, filepath.Clean("/"+r.URL.Path))
		if info, err := os.Stat(p); err != nil || info.IsDir() {
			if r.URL.Path != "/" && !strings.Contains(filepath.Base(r.URL.Path), ".") {
				http.ServeFile(w, r, filepath.Join(dir, "index.html"))
				return
			}
		}
		fs.ServeHTTP(w, r)
	})
}
