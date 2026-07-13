package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
)

// Comment is one node of the fully-parsed comment tree.
type Comment struct {
	ID            string    `json:"id"`
	Author        string    `json:"author"`
	Body          string    `json:"body"`
	Score         int       `json:"score"`
	ScoreHidden   bool      `json:"scoreHidden"`
	CreatedUTC    float64   `json:"createdUtc"`
	IsSubmitter   bool      `json:"isSubmitter"`
	Distinguished string    `json:"distinguished,omitempty"`
	Stickied      bool      `json:"stickied"`
	Replies       []Comment `json:"replies,omitempty"`
	// Replies reddit didn't include in this response ("load more" stubs).
	MoreCount int `json:"moreCount,omitempty"`
}

type commentsResponse struct {
	Comments []Comment `json:"comments"`
	More     int       `json:"more"`
}

type cListing struct {
	Data struct {
		Children []struct {
			Kind string          `json:"kind"`
			Data json.RawMessage `json:"data"`
		} `json:"children"`
	} `json:"data"`
}

type cData struct {
	ID            string          `json:"id"`
	Author        string          `json:"author"`
	Body          string          `json:"body"`
	Score         int             `json:"score"`
	ScoreHidden   bool            `json:"score_hidden"`
	CreatedUTC    float64         `json:"created_utc"`
	IsSubmitter   bool            `json:"is_submitter"`
	Distinguished string          `json:"distinguished"`
	Stickied      bool            `json:"stickied"`
	Replies       json.RawMessage `json:"replies"` // "" or a nested listing
}

// parseComments turns a reddit comment listing into a tree, returning the
// comments plus the count of replies hidden behind "more" stubs at this level.
func parseComments(l cListing) ([]Comment, int) {
	var out []Comment
	more := 0
	for _, ch := range l.Data.Children {
		switch ch.Kind {
		case "t1":
			var d cData
			if json.Unmarshal(ch.Data, &d) != nil {
				continue
			}
			c := Comment{
				ID:            d.ID,
				Author:        d.Author,
				Body:          d.Body,
				Score:         d.Score,
				ScoreHidden:   d.ScoreHidden,
				CreatedUTC:    d.CreatedUTC,
				IsSubmitter:   d.IsSubmitter,
				Distinguished: d.Distinguished,
				Stickied:      d.Stickied,
			}
			if len(d.Replies) > 2 { // not "" / null / {}
				var rl cListing
				if json.Unmarshal(d.Replies, &rl) == nil {
					c.Replies, c.MoreCount = parseComments(rl)
				}
			}
			out = append(out, c)
		case "more":
			var m struct {
				Count int `json:"count"`
			}
			if json.Unmarshal(ch.Data, &m) == nil {
				more += m.Count
			}
		}
	}
	return out, more
}

var postIDRe = regexp.MustCompile(`^[a-z0-9]+$`)

var commentSorts = map[string]bool{
	"confidence": true, "top": true, "new": true,
	"controversial": true, "old": true, "qa": true,
}

func handleComments(w http.ResponseWriter, r *http.Request) {
	id := strings.ToLower(r.URL.Query().Get("id"))
	if !postIDRe.MatchString(id) {
		http.Error(w, "invalid post id", http.StatusBadRequest)
		return
	}
	sort := r.URL.Query().Get("sort")
	if !commentSorts[sort] {
		sort = "confidence"
	}

	var resp *http.Response
	lastStatus := 0
	for _, host := range feedHosts {
		target := fmt.Sprintf("%scomments/%s/.json?raw_json=1&limit=150&sort=%s", host, id, sort)
		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target, nil)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		req.Header.Set("User-Agent", userAgent)
		req.Header.Set("Accept", "application/json")
		if cookie := r.Header.Get("X-Reddit-Cookie"); cookie != "" {
			req.Header.Set("Cookie", cookie)
		}
		resp, err = httpClient.Do(req)
		if err != nil {
			http.Error(w, "reddit request failed: "+err.Error(), http.StatusBadGateway)
			return
		}
		if resp.StatusCode == http.StatusOK {
			break
		}
		lastStatus = resp.StatusCode
		resp.Body.Close()
		resp = nil
	}
	if resp == nil {
		http.Error(w, fmt.Sprintf("reddit returned %d for comments", lastStatus), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// The payload is [post listing, comment listing].
	var payload []cListing
	if err := json.NewDecoder(io.LimitReader(resp.Body, 30<<20)).Decode(&payload); err != nil || len(payload) < 2 {
		http.Error(w, "failed to parse reddit comments", http.StatusBadGateway)
		return
	}

	comments, more := parseComments(payload[1])
	if comments == nil {
		comments = []Comment{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(commentsResponse{Comments: comments, More: more})
}
