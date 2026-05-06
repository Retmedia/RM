import re
import csv
import time
from typing import List, Dict, Optional
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.chrome import ChromeDriverManager

EMAIL_REGEX = r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'

def get_driver(headless: bool = True):
    options = Options()
    if headless:
        options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option('useAutomationExtension', False)
    options.add_argument("--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")

    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=options)
    return driver

def scrape_channel_email(channel_input: str) -> Optional[str]:
    driver = get_driver()
    try:
        if not channel_input.startswith("http"):
            handle = channel_input.strip("@")
            url = f"https://www.youtube.com/@{handle}/about"
        else:
            url = channel_input.rstrip("/")
            if "/about" not in url:
                url += "/about"

        print(f"-> Scraping: {url}")
        driver.get(url)
        time.sleep(4)

        page_text = driver.find_element(By.TAG_NAME, "body").text.lower()

        emails = re.findall(EMAIL_REGEX, driver.page_source, re.IGNORECASE)
        emails = list(dict.fromkeys(emails))

        keywords = ["business", "inquiries", "contact", "partnership", "sponsor", "info@", "mail", "email"]
        for email in emails:
            if any(kw in page_text for kw in keywords) or "business" in email.lower():
                idx = driver.page_source.lower().find(email.lower())
                snippet = driver.page_source[max(0, idx - 200):idx + 200]
                if any(kw in snippet.lower() for kw in keywords):
                    print(f"   [OK] Found business email: {email}")
                    return email

        if emails:
            print(f"   [WARN] Found fallback email: {emails[0]}")
            return emails[0]

        print("   [MISS] No email found")
        return None
    except Exception as e:
        print(f"   [ERROR] {e}")
        return None
    finally:
        driver.quit()

def batch_scrape(channels: List[str], output_csv: str = "ekko_leads_emails.csv"):
    results: List[Dict] = []
    for i, channel in enumerate(channels, 1):
        print(f"\n[{i}/{len(channels)}] Processing {channel}")
        email = scrape_channel_email(channel)
        results.append({
            "channel": channel,
            "email": email or "NOT_FOUND",
            "status": "Email Verified" if email else "No Email",
        })
        time.sleep(3)

    with open(output_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["channel", "email", "status"])
        writer.writeheader()
        writer.writerows(results)

    found = len([r for r in results if r["email"] != "NOT_FOUND"])
    print(f"\nDONE! {found} emails found.")
    print(f"Results saved to: {output_csv}")
    return results


if __name__ == "__main__":
    test_channels = ["GrahamStephan", "@GrahamStephan"]

    # Option 2: Load from a text file (one @handle or URL per line)
    # with open("channels.txt", "r") as f:
    #     test_channels = [line.strip() for line in f if line.strip()]

    batch_scrape(test_channels)
