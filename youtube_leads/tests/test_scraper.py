from youtube_leads.scraper import best_email, extract_emails


def test_extract_basic() -> None:
    html = '<p>say hi: <a href="mailto:hello@brand.com">hello@brand.com</a></p>'
    assert extract_emails(html) == {"hello@brand.com"}


def test_extract_obfuscated() -> None:
    html = "Reach me at hello [at] brand [dot] com or press(at)brand(dot)com"
    found = extract_emails(html)
    assert "hello@brand.com" in found
    assert "press@brand.com" in found


def test_extract_filters_image_filenames() -> None:
    html = "<img src='logo@2x.png'> me@brand.com"
    assert extract_emails(html) == {"me@brand.com"}


def test_filters_noreply() -> None:
    html = "noreply@example.com or ok@brand.com"
    assert extract_emails(html) == {"ok@brand.com"}


def test_best_email_prefers_business_local_on_domain() -> None:
    options = {"info@other.com", "press@brand.com", "ceo@brand.com"}
    chosen = best_email(options, domain="brand.com")
    assert chosen == "press@brand.com"


def test_best_email_returns_none_for_empty() -> None:
    assert best_email(set()) is None
