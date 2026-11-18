package main

import (
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type Client struct {
	endpoint string
	bucket   string
	http     *http.Client
}

type Head struct {
	Size    int64
	ETag    string
	ModTime time.Time
}

type ListedObject struct {
	Key     string
	Size    int64
	ModTime time.Time
}

type ListResult struct {
	Objects     []ListedObject
	Prefixes    []string
	Truncated   bool
	NextToken   string
}

func NewClient(endpoint, bucket string) *Client {
	return &Client{
		endpoint: strings.TrimRight(endpoint, "/"),
		bucket:   strings.Trim(bucket, "/"),
		http:     &http.Client{Timeout: 0},
	}
}

func (c *Client) objectURL(key string) string {
	var b strings.Builder
	b.WriteString(c.endpoint)
	b.WriteByte('/')
	b.WriteString(url.PathEscape(c.bucket))
	if key == "" {
		return b.String()
	}
	for _, part := range strings.Split(key, "/") {
		b.WriteByte('/')
		b.WriteString(url.PathEscape(part))
	}
	return b.String()
}

func (c *Client) Head(key string) (*Head, error) {
	req, err := http.NewRequest(http.MethodHead, c.objectURL(key), nil)
	if err != nil {
		return nil, err
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	io.Copy(io.Discard, res.Body)
	if res.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if res.StatusCode >= 400 {
		return nil, fmt.Errorf("head %s: HTTP %d", key, res.StatusCode)
	}
	return headFromResponse(res), nil
}

func (c *Client) Get(key string) ([]byte, *Head, error) {
	return c.get(key, "")
}

func (c *Client) GetRange(key string, start, end int64) ([]byte, *Head, error) {
	return c.get(key, fmt.Sprintf("bytes=%d-%d", start, end))
}

func (c *Client) get(key, rangeHeader string) ([]byte, *Head, error) {
	req, err := http.NewRequest(http.MethodGet, c.objectURL(key), nil)
	if err != nil {
		return nil, nil, err
	}
	if rangeHeader != "" {
		req.Header.Set("Range", rangeHeader)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, nil, err
	}
	if res.StatusCode == http.StatusNotFound {
		return nil, nil, nil
	}
	if rangeHeader != "" && res.StatusCode != http.StatusPartialContent && res.StatusCode != http.StatusOK {
		return nil, nil, fmt.Errorf("get %s: HTTP %d", key, res.StatusCode)
	}
	if rangeHeader == "" && res.StatusCode != http.StatusOK {
		return nil, nil, fmt.Errorf("get %s: HTTP %d", key, res.StatusCode)
	}
	return body, headFromResponse(res), nil
}

func (c *Client) Put(key string, body io.Reader) error {
	// The HTTP client closes req.Body after Do; do not let it close a temp file
	// the caller still needs to remove.
	req, err := http.NewRequest(http.MethodPut, c.objectURL(key), io.NopCloser(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	io.Copy(io.Discard, res.Body)
	if res.StatusCode >= 400 {
		return fmt.Errorf("put %s: HTTP %d", key, res.StatusCode)
	}
	return nil
}

func (c *Client) Delete(key string) error {
	req, err := http.NewRequest(http.MethodDelete, c.objectURL(key), nil)
	if err != nil {
		return err
	}
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	io.Copy(io.Discard, res.Body)
	if res.StatusCode != http.StatusNotFound && res.StatusCode >= 400 {
		return fmt.Errorf("delete %s: HTTP %d", key, res.StatusCode)
	}
	return nil
}

type listBucketXML struct {
	XMLName               xml.Name `xml:"ListBucketResult"`
	IsTruncated           bool     `xml:"IsTruncated"`
	NextContinuationToken string   `xml:"NextContinuationToken"`
	Contents              []struct {
		Key          string `xml:"Key"`
		Size         int64  `xml:"Size"`
		LastModified string `xml:"LastModified"`
	} `xml:"Contents"`
	CommonPrefixes []struct {
		Prefix string `xml:"Prefix"`
	} `xml:"CommonPrefixes"`
}

func (c *Client) List(prefix, delimiter, startAfter string, maxKeys int) (*ListResult, error) {
	if maxKeys <= 0 {
		maxKeys = 1000
	}
	q := url.Values{}
	q.Set("prefix", prefix)
	q.Set("max-keys", strconv.Itoa(maxKeys))
	if delimiter != "" {
		q.Set("delimiter", delimiter)
	}
	if startAfter != "" {
		q.Set("start-after", startAfter)
	}
	req, err := http.NewRequest(http.MethodGet, c.endpoint+"/"+url.PathEscape(c.bucket)+"?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 400 {
		return nil, fmt.Errorf("list %s: HTTP %d", prefix, res.StatusCode)
	}
	var parsed listBucketXML
	if err := xml.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("list xml: %w", err)
	}
	out := &ListResult{Truncated: parsed.IsTruncated, NextToken: parsed.NextContinuationToken}
	for _, o := range parsed.Contents {
		item := ListedObject{Key: o.Key, Size: o.Size}
		if t, err := time.Parse(time.RFC3339, o.LastModified); err == nil {
			item.ModTime = t
		}
		out.Objects = append(out.Objects, item)
	}
	for _, p := range parsed.CommonPrefixes {
		out.Prefixes = append(out.Prefixes, p.Prefix)
	}
	return out, nil
}

func headFromResponse(res *http.Response) *Head {
	h := &Head{ETag: res.Header.Get("ETag")}
	if n, err := strconv.ParseInt(res.Header.Get("Content-Length"), 10, 64); err == nil {
		h.Size = n
	}
	if raw := res.Header.Get("Last-Modified"); raw != "" {
		if t, err := time.Parse(time.RFC1123, raw); err == nil {
			h.ModTime = t
		}
	}
	if cr := res.Header.Get("Content-Range"); strings.HasPrefix(cr, "bytes ") {
		// bytes start-end/total
		if slash := strings.LastIndex(cr, "/"); slash >= 0 {
			if n, err := strconv.ParseInt(cr[slash+1:], 10, 64); err == nil && n >= 0 {
				// total size is useful for range reads; Size still is the body length
				_ = n
			}
		}
	}
	return h
}
