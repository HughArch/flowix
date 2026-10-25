//! Tool-based web search for the built-in assistant.
//!
//! Two backends, chosen from the configured provider:
//! - DeepSeek exposes an OpenAI-adjacent Search API
//!   (`POST /v1/tools/search`) that reuses the model API key. Preferred when
//!   the assistant's API URL points at DeepSeek.
//! - Everything else falls back to DuckDuckGo's HTML endpoint (no API key).
//!
//! Results are plain `title / url / snippet` records; the model cites them in
//! its answer and the UI renders the URLs.

use std::time::Duration;

use regex::Regex;
use serde::Serialize;
use serde_json::Value;

use super::config::BuiltinAiConfig;

const DEFAULT_LIMIT: usize = 5;
const MAX_LIMIT: usize = 10;
const SNIPPET_MAX_CHARS: usize = 400;

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Debug, Serialize)]
pub struct SearchResponse {
    pub ok: bool,
    pub query: String,
    pub provider: String,
    pub results: Vec<SearchResult>,
}

fn clamp_limit(limit: Option<u64>) -> usize {
    limit.unwrap_or(DEFAULT_LIMIT as u64).clamp(1, MAX_LIMIT as u64) as usize
}

fn truncate_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// Run a search. `config` supplies the provider/API key; `query` is the raw
/// user/model query.
pub async fn search(
    config: &BuiltinAiConfig,
    query: &str,
    limit: Option<u64>,
) -> Result<SearchResponse, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("web_search: query 不能为空".into());
    }
    let limit = clamp_limit(limit);

    if is_deepseek(config) {
        match deepseek_search(config, query, limit).await {
            Ok(results) if !results.is_empty() => {
                return Ok(SearchResponse {
                    ok: true,
                    query: query.to_owned(),
                    provider: "deepseek".into(),
                    results,
                })
            }
            Ok(_) => {
                tracing::warn!("web_search: DeepSeek returned no results, falling back to DuckDuckGo");
            }
            Err(error) => {
                tracing::warn!(%error, "web_search: DeepSeek search failed, falling back to DuckDuckGo");
            }
        }
    }

    let results = duckduckgo_search(query, limit).await?;
    Ok(SearchResponse {
        ok: true,
        query: query.to_owned(),
        provider: "duckduckgo".into(),
        results,
    })
}

fn is_deepseek(config: &BuiltinAiConfig) -> bool {
    config.api_url.to_ascii_lowercase().contains("deepseek")
}

fn deepseek_search_endpoint(api_url: &str) -> String {
    let base = api_url.trim().trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/tools/search")
    } else {
        format!("{base}/v1/tools/search")
    }
}

async fn deepseek_search(
    config: &BuiltinAiConfig,
    query: &str,
    limit: usize,
) -> Result<Vec<SearchResult>, String> {
    let endpoint = deepseek_search_endpoint(&config.api_url);
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("web_search: 无法创建 HTTP 客户端: {error}"))?;
    let response = client
        .post(&endpoint)
        .bearer_auth(&config.api_key)
        .json(&serde_json::json!({
            "query": query,
            "count": limit,
            "need_content": false,
        }))
        .send()
        .await
        .map_err(|error| format!("web_search: 搜索请求失败: {error}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "web_search: 搜索服务返回 HTTP {}: {}",
            status.as_u16(),
            truncate_chars(&body, 300)
        ));
    }
    let value: Value = serde_json::from_str(&body)
        .map_err(|error| format!("web_search: 搜索响应不是 JSON: {error}"))?;
    let results = extract_results(&value, limit);
    if results.is_empty() {
        return Err(format!(
            "web_search: 搜索结果为空（响应: {}）",
            truncate_chars(&body, 300)
        ));
    }
    Ok(results)
}

/// Providers wrap search results differently; walk the JSON and take the
/// first array of objects that look like results (have a URL-ish field).
fn extract_results(value: &Value, limit: usize) -> Vec<SearchResult> {
    let mut results = Vec::new();
    collect_result_objects(value, &mut results, limit);
    results
}

fn collect_result_objects(value: &Value, out: &mut Vec<SearchResult>, limit: usize) {
    if out.len() >= limit {
        return;
    }
    match value {
        Value::Array(items) => {
            for item in items {
                if out.len() >= limit {
                    break;
                }
                collect_result_objects(item, out, limit);
            }
        }
        Value::Object(object) => {
            if let Some(result) = result_from_object(object) {
                out.push(result);
                return;
            }
            for value in object.values() {
                if out.len() >= limit {
                    break;
                }
                collect_result_objects(value, out, limit);
            }
        }
        _ => {}
    }
}

fn result_from_object(object: &serde_json::Map<String, Value>) -> Option<SearchResult> {
    let url = ["url", "link", "href"]
        .iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str))
        .filter(|value| value.starts_with("http"))?;
    let title = ["title", "name", "headline"]
        .iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str))
        .unwrap_or(url);
    let snippet = ["snippet", "summary", "description", "content", "text"]
        .iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str))
        .unwrap_or_default();
    Some(SearchResult {
        title: truncate_chars(title, 200),
        url: url.to_owned(),
        snippet: truncate_chars(snippet, SNIPPET_MAX_CHARS),
    })
}

async fn duckduckgo_search(query: &str, limit: usize) -> Result<Vec<SearchResult>, String> {
    let mut url = reqwest::Url::parse("https://duckduckgo.com/html/")
        .map_err(|error| format!("web_search: 搜索地址无效: {error}"))?;
    url.query_pairs_mut().append_pair("q", query);
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .user_agent("Mozilla/5.0 Flowix Agent Web Search")
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|error| format!("web_search: 无法创建 HTTP 客户端: {error}"))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("web_search: 请求失败: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "web_search: 搜索服务返回 HTTP {}",
            response.status().as_u16()
        ));
    }
    let html = response
        .text()
        .await
        .map_err(|error| format!("web_search: 读取响应失败: {error}"))?;
    let results = parse_duckduckgo_html(&html, limit);
    if results.is_empty() {
        return Err("web_search: 未解析到搜索结果（搜索服务可能限流或改版）".into());
    }
    Ok(results)
}

fn parse_duckduckgo_html(html: &str, limit: usize) -> Vec<SearchResult> {
    let anchor_re = Regex::new(
        r#"(?is)<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#,
    )
    .expect("duckduckgo anchor regex");
    let snippet_re = Regex::new(
        r#"(?is)<(?:a|div)\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>(.*?)</(?:a|div)>"#,
    )
    .expect("duckduckgo snippet regex");

    let mut results = Vec::new();
    for captures in anchor_re.captures_iter(html) {
        if results.len() >= limit {
            break;
        }
        let Some(url) = normalize_result_url(&captures[1]) else {
            continue;
        };
        let title = collapse_ws(&html_unescape(&strip_tags(&captures[2])));
        if title.is_empty() {
            continue;
        }
        let anchor_end = captures.get(0).map(|m| m.end()).unwrap_or(0);
        let nearby_end = (anchor_end + 2500).min(html.len());
        let snippet = snippet_re
            .captures(&html[anchor_end..nearby_end])
            .and_then(|caps| caps.get(1))
            .map(|m| collapse_ws(&html_unescape(&strip_tags(m.as_str()))))
            .unwrap_or_default();
        results.push(SearchResult {
            title,
            url,
            snippet: truncate_chars(&snippet, SNIPPET_MAX_CHARS),
        });
    }
    results
}

fn normalize_result_url(raw: &str) -> Option<String> {
    let raw = html_unescape(raw);
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return Some(raw);
    }
    // DuckDuckGo wraps results as `/l/?uddg=<encoded target>`.
    let base = reqwest::Url::parse("https://duckduckgo.com").ok()?;
    let url = base.join(&raw).ok()?;
    if let Some(target) = url
        .query_pairs()
        .find_map(|(key, value)| (key == "uddg").then_some(value.into_owned()))
    {
        if target.starts_with("http") {
            return Some(target);
        }
    }
    None
}

fn strip_tags(value: &str) -> String {
    let tag_re = Regex::new(r"(?is)<[^>]+>").expect("tag regex");
    tag_re.replace_all(value, "").into_owned()
}

fn html_unescape(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

fn collapse_ws(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deepseek_endpoint_handles_both_base_shapes() {
        assert_eq!(
            deepseek_search_endpoint("https://api.deepseek.com"),
            "https://api.deepseek.com/v1/tools/search"
        );
        assert_eq!(
            deepseek_search_endpoint("https://api.deepseek.com/v1/"),
            "https://api.deepseek.com/v1/tools/search"
        );
    }

    #[test]
    fn extracts_nested_result_arrays() {
        let value = serde_json::json!({
            "data": [{
                "title": "Rust",
                "url": "https://rust-lang.org",
                "summary": "A language"
            }]
        });
        let results = extract_results(&value, 5);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Rust");
        assert_eq!(results[0].snippet, "A language");
    }

    #[test]
    fn parses_duckduckgo_fixture() {
        let html = r#"
            <a rel="nofollow" class="result__a" href="/l/?kh=-1&amp;uddg=https%3A%2F%2Fexample.com%2Falpha">Alpha &amp; Beta</a>
            <a class="result__snippet" href="/l/?uddg=https%3A%2F%2Fexample.com%2Falpha">First <b>snippet</b>.</a>
        "#;
        let results = parse_duckduckgo_html(html, 5);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].url, "https://example.com/alpha");
        assert_eq!(results[0].title, "Alpha & Beta");
        assert_eq!(results[0].snippet, "First snippet.");
    }
}
