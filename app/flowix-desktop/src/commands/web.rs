use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebPageMetadata {
    pub url: String,
    pub title: String,
    pub description: String,
    pub image: String,
}

#[tauri::command]
pub async fn parse_web_page(url: String) -> Result<WebPageMetadata, String> {
    let normalized_url = normalize_url(&url)?;
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 Flowix Web Card")
        .redirect(reqwest::redirect::Policy::limited(6))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&normalized_url)
        .header(
            reqwest::header::ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .send()
        .await
        .map_err(|e| format!("failed to fetch page: {e}"))?
        .error_for_status()
        .map_err(|e| format!("page request failed: {e}"))?;

    let final_url = response.url().to_string();
    let html = response
        .text()
        .await
        .map_err(|e| format!("failed to read page: {e}"))?;

    Ok(extract_metadata(&html, &final_url))
}

fn normalize_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("url is empty".into());
    }

    let candidate = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };

    let parsed = reqwest::Url::parse(&candidate).map_err(|_| "invalid url".to_string())?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed.to_string()),
        _ => Err("only http and https urls are supported".into()),
    }
}

fn extract_metadata(html: &str, page_url: &str) -> WebPageMetadata {
    let title = first_non_empty(&[
        meta_content(html, "property", "og:title"),
        meta_content(html, "name", "twitter:title"),
        title_tag(html),
    ]);
    let description = first_non_empty(&[
        meta_content(html, "property", "og:description"),
        meta_content(html, "name", "twitter:description"),
        meta_content(html, "name", "description"),
    ]);
    let image = first_non_empty(&[
        meta_content(html, "property", "og:image"),
        meta_content(html, "name", "twitter:image"),
    ])
    .and_then(|value| resolve_url(page_url, &value));

    WebPageMetadata {
        url: page_url.to_string(),
        title: title.unwrap_or_else(|| page_url.to_string()),
        description: description.unwrap_or_default(),
        image: image.unwrap_or_default(),
    }
}

fn first_non_empty(values: &[Option<String>]) -> Option<String> {
    values
        .iter()
        .flatten()
        .map(|value| html_unescape(value.trim()))
        .find(|value| !value.is_empty())
}

fn title_tag(html: &str) -> Option<String> {
    Regex::new(r#"(?is)<title[^>]*>(.*?)</title>"#)
        .ok()?
        .captures(html)?
        .get(1)
        .map(|m| strip_tags(m.as_str()))
}

fn meta_content(html: &str, key_attr: &str, key_value: &str) -> Option<String> {
    let tag_re = Regex::new(r#"(?is)<meta\b[^>]*>"#).ok()?;
    let result = tag_re.find_iter(html).find_map(|tag| {
        let tag_text = tag.as_str();
        let key = attr_value(tag_text, key_attr)?;
        if !key.eq_ignore_ascii_case(key_value) {
            return None;
        }
        attr_value(tag_text, "content")
    });
    result
}

fn attr_value(tag: &str, name: &str) -> Option<String> {
    let pattern = format!(
        r#"(?is)\b{}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))"#,
        regex::escape(name)
    );
    let captures = Regex::new(&pattern).ok()?.captures(tag)?;
    for index in 1..=3 {
        if let Some(value) = captures.get(index) {
            return Some(value.as_str().to_string());
        }
    }
    None
}

fn strip_tags(value: &str) -> String {
    Regex::new(r#"(?is)<[^>]+>"#)
        .map(|re| re.replace_all(value, "").to_string())
        .unwrap_or_else(|_| value.to_string())
}

fn html_unescape(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .trim()
        .to_string()
}

fn resolve_url(base: &str, value: &str) -> Option<String> {
    let base_url = reqwest::Url::parse(base).ok()?;
    base_url.join(value.trim()).ok().map(|url| url.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BilibiliVideoIds {
    pub aid: u64,
    pub cid: u64,
}

fn parse_bilibili_ids(value: &serde_json::Value, page: u32) -> Result<BilibiliVideoIds, String> {
    if value["code"].as_i64() != Some(0) {
        return Err(format!(
            "Bilibili: {}",
            value["message"].as_str().unwrap_or("request failed")
        ));
    }
    let data = &value["data"];
    let aid = data["aid"]
        .as_u64()
        .filter(|id| *id > 0)
        .ok_or("missing aid")?;
    let cid = data["pages"]
        .as_array()
        .and_then(|pages| {
            pages
                .iter()
                .find(|item| item["page"].as_u64() == Some(u64::from(page)))
        })
        .and_then(|item| item["cid"].as_u64())
        .filter(|id| *id > 0)
        .ok_or("video page not found")?;
    Ok(BilibiliVideoIds { aid, cid })
}

#[tauri::command]
pub async fn resolve_bilibili_video(
    video_id: String,
    page: u32,
) -> Result<BilibiliVideoIds, String> {
    let valid = Regex::new(r"^(BV[0-9A-Za-z]{10}|av[1-9][0-9]*)$").map_err(|e| e.to_string())?;
    if !valid.is_match(&video_id) || page == 0 {
        return Err("invalid Bilibili video or page".into());
    }
    let (key, id) = if let Some(aid) = video_id.strip_prefix("av") {
        ("aid", aid)
    } else {
        ("bvid", video_id.as_str())
    };
    // Bilibili can reject a system proxy exit with HTTP 412 while the same
    // public video is available directly. Retry only this fixed endpoint.
    let response = request_bilibili_view(key, id, false).await?;
    let response = if response.status() == reqwest::StatusCode::PRECONDITION_FAILED {
        request_bilibili_view(key, id, true).await?
    } else {
        response
    };
    let value: serde_json::Value = response
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    parse_bilibili_ids(&value, page)
}

async fn request_bilibili_view(
    key: &str,
    id: &str,
    direct: bool,
) -> Result<reqwest::Response, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(15));
    if direct {
        builder = builder.no_proxy();
    }
    builder
        .build()
        .map_err(|e| e.to_string())?
        .get("https://api.bilibili.com/x/web-interface/view")
        .header(reqwest::header::REFERER, "https://www.bilibili.com/")
        .header(reqwest::header::ACCEPT, "application/json, text/plain, */*")
        .query(&[(key, id)])
        .send()
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod bilibili_tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires Bilibili network access"]
    async fn resolves_live_video() {
        let ids = resolve_bilibili_video("BV1TGnP6VE2f".into(), 1)
            .await
            .expect("live Bilibili resolution failed");
        assert_eq!(ids.aid, 117472724261620);
        assert_eq!(ids.cid, 42907075029);
    }

    #[test]
    fn selects_requested_page_and_rejects_invalid_responses() {
        let value = serde_json::json!({"code":0,"data":{"aid":117472724261620_u64,"pages":[{"page":1,"cid":42},{"page":2,"cid":43}]}});
        let ids = parse_bilibili_ids(&value, 2).unwrap();
        assert_eq!(ids.aid, 117472724261620);
        assert_eq!(ids.cid, 43);
        assert!(parse_bilibili_ids(&value, 3).is_err());
        assert!(
            parse_bilibili_ids(&serde_json::json!({"code":-400,"message":"error"}), 1).is_err()
        );
    }
}
