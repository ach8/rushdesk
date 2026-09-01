import httpx

url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
print("Downloading cloudflared.exe from Cloudflare GitHub...")

with httpx.stream("GET", url, follow_redirects=True, timeout=60) as r:
    total = 0
    with open("cloudflared.exe", "wb") as f:
        for chunk in r.iter_bytes(chunk_size=1024 * 1024):
            f.write(chunk)
            total += len(chunk)
            print(f"Downloaded {round(total / (1024*1024), 1)} MB...", end="\r")

print("\nDownloaded cloudflared.exe successfully!")
