import argparse
import csv
import re
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import quote_plus

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


def is_fresh_profile(profile_dir: Optional[str]) -> bool:
    """A profile dir is fresh if it doesn't have Chrome's Default folder yet."""
    if not profile_dir:
        return False
    return not (Path(profile_dir).expanduser().resolve() / "Default").exists()


def prompt_signin(driver) -> None:
    print("\n" + "=" * 64)
    print("  FIRST-RUN SIGN-IN")
    print("=" * 64)
    print("  A Chrome window has opened on youtube.com.")
    print("  1. Sign in to YouTube (any Google account works)")
    print("  2. Open ONE channel manually, click About, then click")
    print("     'View email address' and solve the CAPTCHA")
    print("  3. Come back here and press Enter to start the batch")
    print("=" * 64)
    try:
        driver.get("https://www.youtube.com")
    except Exception:
        pass
    input("\nPress Enter when signed in and ready... ")


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


def extract_channel_metadata(driver) -> Dict[str, str]:
    """Pull channel name, subscriber count, and canonical URL from meta tags."""
    meta = {
        "Channel Name": "",
        "YouTube URL": "",
        "Subscribers": "",
        "Subscriber Count": "",
    }

    def attr(xpath: str, attr_name: str) -> str:
        try:
            return driver.find_element(By.XPATH, xpath).get_attribute(attr_name) or ""
        except Exception:
            return ""

    meta["Channel Name"] = (
        attr("//meta[@itemprop='name']", "content")
        or attr("//meta[@property='og:title']", "content")
    )
    meta["YouTube URL"] = (
        attr("//link[@rel='canonical']", "href")
        or attr("//meta[@property='og:url']", "content")
        or driver.current_url
    )
    try:
        text = driver.find_element(
            By.XPATH, "//yt-content-metadata-view-model//span[contains(., 'subscriber')]"
        ).text
        readable = text.replace(" subscribers", "").replace(" subscriber", "").strip()
        meta["Subscribers"] = readable
        count = parse_subscriber_count(readable)
        meta["Subscriber Count"] = str(count) if count is not None else ""
    except Exception:
        pass
    return meta


def parse_subscriber_count(text: str) -> Optional[int]:
    """'1.2M' -> 1200000, '450K' -> 450000, '1,234' -> 1234. None on no match."""
    if not text:
        return None
    s = text.strip().lower().replace(",", "")
    m = re.match(r"^([\d.]+)\s*([kmb])?$", s)
    if not m:
        return None
    try:
        num = float(m.group(1))
    except ValueError:
        return None
    mult = {"k": 1_000, "m": 1_000_000, "b": 1_000_000_000}.get(m.group(2) or "", 1)
    return int(num * mult)


def scrape_channel(driver, channel_input: str) -> Dict[str, str]:
    """Try the modal flow first, fall back to /about, then regex sweep.
    Returns a row dict ready for CSV write."""
    row = {
        "Channel Name": "",
        "YouTube Handle": channel_input,
        "YouTube URL": "",
        "Subscribers": "",
        "Subscriber Count": "",
        "Email": "NOT_FOUND",
        "Status": "No Email",
    }

    url = normalize_url(channel_input)
    print(f"   -> {url}")
    driver.get(url)
    time.sleep(3)

    row.update(extract_channel_metadata(driver))

    if open_about_modal(driver):
        reveal_email(driver)

    emails = extract_emails(driver)

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
        return row

    best = pick_best_email(emails, driver.page_source.lower())
    print(f"   [OK] {best}  ({len(emails)} candidate(s))")
    row["Email"] = best or "NOT_FOUND"
    row["Status"] = "Email Verified" if best else "No Email"
    return row


def load_channels(path: Path) -> List[str]:
    lines = path.read_text(encoding="utf-8").splitlines()
    return [ln.strip() for ln in lines if ln.strip() and not ln.strip().startswith("#")]


CSV_FIELDS = [
    "Channel Name",
    "YouTube Handle",
    "YouTube URL",
    "Subscribers",
    "Subscriber Count",
    "Email",
    "Status",
]


def load_existing_rows(path: Path) -> Dict[str, Dict[str, str]]:
    if not path.exists():
        return {}
    rows: Dict[str, Dict[str, str]] = {}
    with path.open("r", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            key = row.get("YouTube Handle", "").strip()
            if key:
                rows[key] = row
    return rows


def batch(channels: List[str], output_csv: Path, profile_dir: Optional[str],
          headless: bool, delay: float, retry_misses: bool, signin: bool) -> None:
    existing = load_existing_rows(output_csv)
    fresh_csv = not existing

    queue: List[str] = []
    for ch in channels:
        prior = existing.get(ch)
        if prior is None:
            queue.append(ch)
        elif retry_misses and prior.get("Email", "NOT_FOUND") == "NOT_FOUND":
            queue.append(ch)
        else:
            print(f"[skip] {ch} (already in CSV: {prior.get('Email')})")

    if not queue:
        print("Nothing to do -- all channels already processed.")
        return

    needs_signin = signin or is_fresh_profile(profile_dir)
    if needs_signin and headless:
        print("First-run sign-in needed but --headless was passed.")
        print("Re-run without --headless once to sign in, then headless works.")
        sys.exit(1)

    driver = get_driver(profile_dir, headless)
    if needs_signin:
        prompt_signin(driver)

    found = 0
    written = 0

    f = output_csv.open("a", newline="", encoding="utf-8")
    writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
    if fresh_csv:
        writer.writeheader()
        f.flush()

    try:
        for i, ch in enumerate(queue, 1):
            print(f"\n[{i}/{len(queue)}] {ch}")
            try:
                row = scrape_channel(driver, ch)
            except Exception as exc:
                print(f"   [ERROR] {exc}")
                row = {field: "" for field in CSV_FIELDS}
                row["YouTube Handle"] = ch
                row["Email"] = "NOT_FOUND"
                row["Status"] = "No Email"
            writer.writerow(row)
            f.flush()
            written += 1
            if row["Email"] != "NOT_FOUND":
                found += 1
            time.sleep(delay)
    finally:
        f.close()
        driver.quit()

    print(f"\n{found}/{written} new emails found -> {output_csv}")


# ----- Discovery -----------------------------------------------------------

def discover_channels(driver, query: str, max_results: int) -> List[str]:
    """Search YouTube for channels matching `query`, return up to max_results @handles."""
    # sp=EgIQAg%3D%3D filters search to "Channel" results
    url = (f"https://www.youtube.com/results?search_query={quote_plus(query)}"
           "&sp=EgIQAg%253D%253D")
    print(f"-> Discovering channels for: {query!r}")
    print(f"   {url}")
    driver.get(url)
    time.sleep(4)

    handles: List[str] = []
    seen = set()
    for _ in range(8):
        for el in driver.find_elements(By.XPATH, "//a[starts-with(@href, '/@')]"):
            href = el.get_attribute("href") or ""
            m = re.search(r"youtube\.com/(@[A-Za-z0-9._-]+)", href)
            if not m:
                continue
            handle = m.group(1)
            if handle not in seen:
                seen.add(handle)
                handles.append(handle)
        if len(handles) >= max_results:
            break
        driver.execute_script(
            "window.scrollBy(0, document.documentElement.scrollHeight);"
        )
        time.sleep(2)

    handles = handles[:max_results]
    print(f"   discovered {len(handles)} channel handle(s)")
    return handles


def append_handles(input_path: Path, handles: List[str], query: str) -> int:
    """Append new handles to the channel list file, skipping ones already there."""
    existing: set = set()
    if input_path.exists():
        for line in input_path.read_text(encoding="utf-8").splitlines():
            ln = line.strip()
            if ln and not ln.startswith("#"):
                existing.add(ln.lstrip("@").lower())

    new = [h for h in handles if h.lstrip("@").lower() not in existing]
    if not new:
        print("   no new handles to add (all already in input file)")
        return 0

    with input_path.open("a", encoding="utf-8") as f:
        f.write(f"\n# discovered for query: {query}\n")
        for h in new:
            f.write(h + "\n")
    print(f"   appended {len(new)} new handles to {input_path}")
    return len(new)


# ----- Draft generation ----------------------------------------------------

DEFAULT_SUBJECT = "Your YouTube videos transcribed and ready"

DEFAULT_BODY = """Hey

Just wrapped up transcribing all your videos from your channel through my service Ekko (we archive YouTube channels into searchable text). Master transcript, individual files per video, subtitle files, and a searchable index spreadsheet. Everything's ready to go in my folder.

Figured you'd want it and build something from it. Your library has years of valuable knowledge in it, and having it all searchable as text means you can repurpose it for written posts, new course content, books, email newsletters, whatever you'd like to build next.

Grab it here: https://buy.stripe.com/3cI7sMftidQbdtp6azdIA05
$197 one-time. I'll send the full archive over within the hour of purchase.

If it's not for you, no worries. Just wanted to put it in front of you since the work's already done, and a lot of creators find it useful.

Best, Garrett
Ekko
ekkoarchive.com
"""


def gen_drafts(csv_path: Path, output_path: Path, batch_size: int,
               from_address: str) -> None:
    if not csv_path.exists():
        print(f"No CSV at {csv_path}. Run the scraper first.")
        sys.exit(1)

    rows: List[Dict[str, str]] = []
    with csv_path.open("r", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            email = (row.get("Email") or "").strip()
            if email and email != "NOT_FOUND" and "@" in email:
                rows.append(row)

    if not rows:
        print("No verified emails in the CSV yet -- run the scraper first.")
        sys.exit(1)

    batches = [rows[i:i + batch_size] for i in range(0, len(rows), batch_size)]
    lines: List[str] = []
    lines.append(f"# {len(rows)} verified emails across {len(batches)} BCC drafts")
    lines.append(f"# Capped at {batch_size} BCC per draft (Gmail deliverability)")
    lines.append("# Open Gmail, paste each draft, hit send. Spread across days.")
    lines.append("")

    for i, batch in enumerate(batches, 1):
        bcc_list = ", ".join(r["Email"] for r in batch)
        lines.append("=" * 72)
        lines.append(f"DRAFT {i} of {len(batches)}  --  {len(batch)} BCC")
        lines.append("=" * 72)
        lines.append(f"From:    {from_address}")
        lines.append(f"To:      {from_address}")
        lines.append(f"Bcc:     {bcc_list}")
        lines.append(f"Subject: {DEFAULT_SUBJECT}")
        lines.append("")
        lines.append(DEFAULT_BODY.strip())
        lines.append("")
        lines.append("--- recipients in this draft ---")
        for r in batch:
            name = r.get("Channel Name") or "?"
            subs = r.get("Subscribers") or "?"
            lines.append(f"  {name} ({subs} subs) -> {r['Email']}")
        lines.append("")

    output_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"Wrote {len(batches)} draft(s) covering {len(rows)} email(s) -> {output_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="YouTube channel email scraper")
    parser.add_argument("channels", nargs="*",
                        help="Channel handles or URLs (skips --input if given)")
    parser.add_argument("-i", "--input", default="channels.txt",
                        help="File with one @handle or URL per line (default: channels.txt)")
    parser.add_argument("-o", "--output", default="youtube_leads.csv",
                        help="Output CSV path")
    parser.add_argument("--profile-dir", default="./chrome-profile",
                        help="Persistent Chrome user-data-dir; sign in once and reuse")
    parser.add_argument("--headless", action="store_true",
                        help="Run Chrome headless (default: visible window for reliability)")
    parser.add_argument("--delay", type=float, default=3.0,
                        help="Seconds between channels")
    parser.add_argument("--retry-misses", action="store_true",
                        help="Re-run channels in the existing CSV that have NOT_FOUND")
    parser.add_argument("--signin", action="store_true",
                        help="Force the sign-in pause even on an existing profile")
    parser.add_argument("--discover", metavar="QUERY",
                        help="Search YouTube for channels matching QUERY and append handles to --input")
    parser.add_argument("--max", type=int, default=50,
                        help="Max channels to discover per --discover query (default 50)")
    parser.add_argument("--gen-drafts", action="store_true",
                        help="After scraping (or alone), write drafts.txt from the CSV")
    parser.add_argument("--drafts-out", default="drafts.txt",
                        help="Path for the generated drafts file")
    parser.add_argument("--batch-size", type=int, default=25,
                        help="BCC recipients per draft (default 25, Gmail-safe)")
    parser.add_argument("--from-address", default="abdullagarrett@gmail.com",
                        help="From/To address used in drafts.txt")
    args = parser.parse_args()

    # --gen-drafts alone: just read CSV and write drafts.txt, no browser needed
    if args.gen_drafts and not args.discover and not args.channels and not (
        args.input != "channels.txt" and Path(args.input).exists()
    ) and Path(args.output).exists():
        gen_drafts(Path(args.output), Path(args.drafts_out),
                   args.batch_size, args.from_address)
        return

    # Discovery: append new handles to channels.txt before scraping
    if args.discover:
        if is_fresh_profile(args.profile_dir) and args.headless:
            print("First-run sign-in needed but --headless was passed.")
            print("Re-run without --headless once to sign in.")
            sys.exit(1)
        driver = get_driver(args.profile_dir, args.headless)
        try:
            if is_fresh_profile(args.profile_dir) or args.signin:
                prompt_signin(driver)
            handles = discover_channels(driver, args.discover, args.max)
        finally:
            driver.quit()
        Path(args.input).touch(exist_ok=True)
        append_handles(Path(args.input), handles, args.discover)

    # Resolve the channel list to scrape
    if args.channels:
        channels = args.channels
    else:
        path = Path(args.input)
        if not path.exists():
            if args.gen_drafts:
                gen_drafts(Path(args.output), Path(args.drafts_out),
                           args.batch_size, args.from_address)
                return
            print(f"No channels passed and {path} not found.", file=sys.stderr)
            sys.exit(1)
        channels = load_channels(path)

    if not channels:
        print("No channels to process.", file=sys.stderr)
        sys.exit(1)

    batch(channels, Path(args.output), args.profile_dir, args.headless,
          args.delay, args.retry_misses, args.signin)

    if args.gen_drafts:
        gen_drafts(Path(args.output), Path(args.drafts_out),
                   args.batch_size, args.from_address)


if __name__ == "__main__":
    main()
