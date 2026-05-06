import argparse
import csv
import re
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional

from selenium import webdriver
from selenium.common.exceptions import TimeoutException, WebDriverException
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait
from webdriver_manager.chrome import ChromeDriverManager

EMAIL_REGEX = r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}"

# Noise we never want to return as a "lead email"
EMAIL_NOISE = (
    "@youtube.com", "@google.com", "@youtu.be", "googleusercontent.com",
    "noreply@", "no-reply@", "@sentry.io", "@example.", "@2x", "@3x",
)

# Buttons that open the channel About / Links dialog (2024+ flow).
# YouTube changes these often -- we try several in order.
ABOUT_TRIGGER_XPATHS = [
    "//yt-description-preview-view-model//button",
    "//button[contains(@aria-label, 'About')]",
    "//button[.//span[normalize-space()='...more']]",
    "//button[.//span[contains(text(), 'more')]]",
    "//tp-yt-paper-button[contains(., 'More about')]",
    "//tp-yt-paper-button[contains(., 'Links')]",
    "//tp-yt-paper-tab[.//div[normalize-space()='About']]",
]

# "View email address" button inside the About dialog (requires sign-in)
VIEW_EMAIL_XPATHS = [
    "//button[.//*[contains(text(), 'View email address')]]",
    "//button[.//*[contains(text(), 'View email')]]",
    "//ytd-button-renderer//button[contains(., 'View email')]",
    "//yt-button-shape/button[contains(., 'View email')]",
]

# Wait targets that confirm the modal actually rendered
MODAL_OPEN_TARGETS = [
    "//tp-yt-paper-dialog[@aria-modal='true']",
    "//ytd-engagement-panel-section-list-renderer[@visibility='ENGAGEMENT_PANEL_VISIBILITY_EXPANDED']",
    "//*[@id='about-container']",
]

CONTACT_KEYWORDS = (
    "business", "inquiries", "contact", "partnership",
    "sponsor", "press", "booking", "info@", "mail",
)


def get_driver(profile_dir: Optional[str], headless: bool) -> webdriver.Chrome:
    options = Options()
    if headless:
        options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option("useAutomationExtension", False)
    options.add_argument(
        "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )
    if profile_dir:
        path = Path(profile_dir).expanduser().resolve()
        path.mkdir(parents=True, exist_ok=True)
        options.add_argument(f"--user-data-dir={path}")

    service = Service(ChromeDriverManager().install())
    return webdriver.Chrome(service=service, options=options)


def normalize_url(channel_input: str, force_about: bool = False) -> str:
    if channel_input.startswith("http"):
        url = channel_input.rstrip("/")
    else:
        handle = channel_input.strip().lstrip("@")
        url = f"https://www.youtube.com/@{handle}"
    if force_about and not url.endswith("/about"):
        url = url.rstrip("/") + "/about"
    return url


def try_click(driver, xpaths: List[str], timeout: int = 6) -> bool:
    for xpath in xpaths:
        try:
            elem = WebDriverWait(driver, timeout).until(
                EC.element_to_be_clickable((By.XPATH, xpath))
            )
            driver.execute_script(
                "arguments[0].scrollIntoView({block: 'center'});", elem
            )
            time.sleep(0.4)
            try:
                elem.click()
            except WebDriverException:
                driver.execute_script("arguments[0].click();", elem)
            return True
        except TimeoutException:
            continue
        except Exception:
            continue
    return False


def wait_for_modal(driver, timeout: int = 5) -> bool:
    for xpath in MODAL_OPEN_TARGETS:
        try:
            WebDriverWait(driver, timeout).until(
                EC.presence_of_element_located((By.XPATH, xpath))
            )
            return True
        except TimeoutException:
            continue
    return False


def open_about_modal(driver) -> bool:
    if try_click(driver, ABOUT_TRIGGER_XPATHS, timeout=6):
        wait_for_modal(driver, timeout=4)
        time.sleep(1.5)
        return True
    return False


def reveal_email(driver) -> bool:
    if try_click(driver, VIEW_EMAIL_XPATHS, timeout=4):
        # The email may render after a brief CAPTCHA / fade-in
        time.sleep(2.5)
        return True
    return False


def extract_emails(driver) -> List[str]:
    raw = re.findall(EMAIL_REGEX, driver.page_source, re.IGNORECASE)
    seen, cleaned = set(), []
    for e in raw:
        low = e.lower()
        if any(n in low for n in EMAIL_NOISE):
            continue
        if low in seen:
            continue
        seen.add(low)
        cleaned.append(e)
    return cleaned


def pick_best_email(emails: List[str], page_source_lower: str) -> Optional[str]:
    if not emails:
        return None
    best, best_score = emails[0], -1
    for e in emails:
        idx = page_source_lower.find(e.lower())
        snippet = page_source_lower[max(0, idx - 240): idx + 240] if idx >= 0 else ""
        score = sum(1 for kw in CONTACT_KEYWORDS if kw in snippet)
        if "business" in e.lower():
            score += 2
        if score > best_score:
            best, best_score = e, score
    return best


def scrape_channel_email(driver, channel_input: str) -> Optional[str]:
    """Try the modal flow first, fall back to /about page, then regex sweep."""
    url = normalize_url(channel_input)
    print(f"   -> {url}")
    driver.get(url)
    time.sleep(3)

    # New flow: open About modal on the channel home page
    opened = open_about_modal(driver)
    if opened:
        reveal_email(driver)

    emails = extract_emails(driver)

    # Fallback: /about URL (still works as a deep-link to the modal on many channels)
    if not emails:
        about_url = normalize_url(channel_input, force_about=True)
        if about_url != driver.current_url.rstrip("/"):
            print(f"   fallback -> {about_url}")
            driver.get(about_url)
            time.sleep(3)
            open_about_modal(driver)
            reveal_email(driver)
            emails = extract_emails(driver)

    if not emails:
        print("   [MISS] no email found")
        return None

    best = pick_best_email(emails, driver.page_source.lower())
    print(f"   [OK] {best}  ({len(emails)} candidate(s))")
    return best


def load_channels(path: Path) -> List[str]:
    lines = path.read_text(encoding="utf-8").splitlines()
    return [ln.strip() for ln in lines if ln.strip() and not ln.strip().startswith("#")]


def batch(channels: List[str], output_csv: Path, profile_dir: Optional[str],
          headless: bool, delay: float) -> None:
    driver = get_driver(profile_dir, headless)
    results: List[Dict] = []
    try:
        for i, ch in enumerate(channels, 1):
            print(f"\n[{i}/{len(channels)}] {ch}")
            try:
                email = scrape_channel_email(driver, ch)
            except Exception as exc:
                print(f"   [ERROR] {exc}")
                email = None
            results.append({
                "channel": ch,
                "email": email or "NOT_FOUND",
                "status": "Email Verified" if email else "No Email",
            })
            time.sleep(delay)
    finally:
        driver.quit()

    with output_csv.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["channel", "email", "status"])
        writer.writeheader()
        writer.writerows(results)

    found = sum(1 for r in results if r["email"] != "NOT_FOUND")
    print(f"\n{found}/{len(results)} emails found -> {output_csv}")


def main() -> None:
    parser = argparse.ArgumentParser(description="YouTube channel email scraper")
    parser.add_argument("channels", nargs="*",
                        help="Channel handles or URLs (skips --input if given)")
    parser.add_argument("-i", "--input", default="channels.txt",
                        help="File with one @handle or URL per line (default: channels.txt)")
    parser.add_argument("-o", "--output", default="ekko_leads_emails.csv",
                        help="Output CSV path")
    parser.add_argument("--profile-dir", default="./chrome-profile",
                        help="Persistent Chrome user-data-dir; sign in once and reuse")
    parser.add_argument("--headless", action="store_true",
                        help="Run Chrome headless (default: visible window for reliability)")
    parser.add_argument("--delay", type=float, default=3.0,
                        help="Seconds between channels")
    args = parser.parse_args()

    if args.channels:
        channels = args.channels
    else:
        path = Path(args.input)
        if not path.exists():
            print(f"No channels passed and {path} not found.", file=sys.stderr)
            sys.exit(1)
        channels = load_channels(path)

    if not channels:
        print("No channels to process.", file=sys.stderr)
        sys.exit(1)

    batch(channels, Path(args.output), args.profile_dir, args.headless, args.delay)


if __name__ == "__main__":
    main()
