#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Universal Video & GIF Downloader (Pinterest + YouTube)
Скрипт для скачивания видео с Pinterest и YouTube с выбором качества,
обрезкой фрагментов и сохранением в формате GIF, MP4 (видео со звуком) или обоих.
"""

import os
import sys
import re
import json
import time
import shutil
import argparse
import tempfile
import urllib.parse
from pathlib import Path

# Обеспечиваем корректный вывод (русский текст и спецсимволы) в консоли Windows
if sys.platform.startswith("win"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Попытка импорта сторонних библиотек
try:
    import requests
except ImportError:
    print("[ОШИБКА] Библиотека 'requests' не установлена.")
    print("Установите: pip install requests")
    sys.exit(1)

try:
    import yt_dlp
except ImportError:
    print("[ОШИБКА] Библиотека 'yt-dlp' не установлена.")
    print("Установите: pip install yt-dlp")
    sys.exit(1)

try:
    import imageio_ffmpeg
    HAS_IMAGEIO_FFMPEG = True
except ImportError:
    HAS_IMAGEIO_FFMPEG = False

# Папка скрипта (по умолчанию сохраняем результат сюда)
SCRIPT_DIR = Path(__file__).resolve().parent

# Заголовки для HTTP-запросов (имитация браузера Chrome)
BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
}


def sanitize_filename(name: str, max_length: int = 70) -> str:
    """Очищает строку от недопустимых символов файловой системы."""
    name = re.sub(r'[\\/*?:"<>|]', "", name)
    name = re.sub(r"\s+", "_", name).strip(" ._-")
    if not name:
        name = "video"
    return name[:max_length]


def get_ffmpeg_exe() -> str:
    """Находит исполняемый файл FFmpeg (через imageio-ffmpeg или системный PATH)."""
    if HAS_IMAGEIO_FFMPEG:
        try:
            exe = imageio_ffmpeg.get_ffmpeg_exe()
            if exe and os.path.isfile(exe):
                return exe
        except Exception:
            pass

    system_ffmpeg = shutil.which("ffmpeg")
    if system_ffmpeg:
        return system_ffmpeg

    raise RuntimeError(
        "FFmpeg не найден! Установите библиотеку 'imageio-ffmpeg':\n"
        "pip install imageio-ffmpeg\n"
        "или установите FFmpeg в систему и добавьте его в PATH."
    )


def is_youtube_url(url: str) -> bool:
    """Проверяет, является ли ссылка ютубовской."""
    u = url.lower()
    return "youtube.com" in u or "youtu.be" in u


def is_pinterest_url(url: str) -> bool:
    """Проверяет, является ли ссылка Pinterest."""
    u = url.lower()
    return "pinterest." in u or "pin.it" in u or "pinimg.com" in u


def resolve_url(raw_url: str) -> str:
    """Разворачивает короткие ссылки (pin.it, youtu.be) и нормализует URL."""
    url = raw_url.strip().strip("'\"<>")
    if not url.startswith("http://") and not url.startswith("https://"):
        url = "https://" + url

    # Разворачиваем pin.it
    if "pin.it" in url:
        print("[*] Разворачиваем короткую ссылку pin.it...")
        try:
            resp = requests.get(url, headers=BROWSER_HEADERS, allow_redirects=True, timeout=12)
            url = resp.url
            print(f"[+] Итоговый URL: {url}")
        except Exception as e:
            print(f"[!] Не удалось автоматически развернуть pin.it ({e}), пробуем как есть...")

    return url


def is_direct_mp4(url: str) -> bool:
    """Проверяет, является ли ссылка прямой на mp4 файл."""
    parsed = urllib.parse.urlparse(url)
    path = parsed.path.lower()
    return path.endswith(".mp4") or "v1.pinimg.com/videos" in url or "v.pinimg.com" in url


def parse_time_trim(trim_str: str | None) -> tuple[str | None, str | None]:
    """Парсит строку диапазона времени: '0:10-0:25' -> ('0:10', '0:25')."""
    if not trim_str or not trim_str.strip():
        return None, None
    s = trim_str.strip().replace("–", "-").replace("—", "-")
    if "-" in s:
        parts = s.split("-", 1)
        start = parts[0].strip() or None
        end = parts[1].strip() or None
        return start, end
    parts = s.split()
    if len(parts) == 2:
        return parts[0].strip(), parts[1].strip()
    return s, None


def download_stream(url: str, target_file: Path) -> bool:
    """Скачивает файл по прямой ссылке с отображением прогресса."""
    print(f"[*] Скачивание напрямую: {url[:70]}...")
    headers = BROWSER_HEADERS.copy()
    if "pinimg.com" in url:
        headers["Referer"] = "https://www.pinterest.com/"

    with requests.get(url, stream=True, headers=headers, timeout=30) as resp:
        resp.raise_for_status()
        total_size = int(resp.headers.get("content-length", 0))
        downloaded = 0

        with open(target_file, "wb") as f:
            for chunk in resp.iter_content(chunk_size=65536):
                if not chunk:
                    continue
                f.write(chunk)
                downloaded += len(chunk)
                if total_size > 0:
                    pct = (downloaded / total_size) * 100
                    mb_cur = downloaded / (1024 * 1024)
                    mb_tot = total_size / (1024 * 1024)
                    print(f"\r[+] Загружено: {mb_cur:.1f} МБ / {mb_tot:.1f} МБ ({pct:.1f}%)", end="", flush=True)
                else:
                    mb_cur = downloaded / (1024 * 1024)
                    print(f"\r[+] Загружено: {mb_cur:.1f} МБ", end="", flush=True)

    print()
    return True


def scrape_video_from_pinterest_page(page_url: str) -> tuple[str | None, str | None]:
    """Резервный парсер Pinterest."""
    try:
        print("[*] Поиск видео через веб-парсинг страницы...")
        resp = requests.get(page_url, headers=BROWSER_HEADERS, timeout=15)
        if resp.status_code != 200:
            return None, None

        html = resp.text
        title = None

        title_match = re.search(r'<meta property="og:title" content="([^"]+)"', html)
        if title_match:
            title = title_match.group(1).split(" | ")[0].strip()

        # Поиск в JSON-LD
        ld_matches = re.findall(r'<script type="application/ld\+json">({.*?})</script>', html, re.DOTALL)
        for ld_str in ld_matches:
            try:
                data = json.loads(ld_str)
                if isinstance(data, dict):
                    if data.get("@type") == "VideoObject" and data.get("contentUrl"):
                        return data["contentUrl"], title or data.get("name")
            except Exception:
                pass

        unescaped_html = html.replace(r"\/", "/")
        video_urls = re.findall(
            r'https?://[a-zA-Z0-9.\-_]*pinimg\.com/videos/[^\s"\'<>\\]+?\.mp4',
            unescaped_html,
        )

        if video_urls:
            def quality_score(u: str) -> int:
                u_lower = u.lower()
                if "720p" in u_lower:
                    return 100
                if "480p" in u_lower:
                    return 80
                if "exp" in u_lower:
                    return 60
                return 10

            sorted_urls = sorted(set(video_urls), key=quality_score, reverse=True)
            return sorted_urls[0], title

        video_tag_match = re.search(r'<video[^>]+src="([^">]+)"', html)
        if video_tag_match:
            return video_tag_match.group(1), title

    except Exception as e:
        print(f"[!] Ошибка веб-парсинга: {e}")

    return None, None


def download_video(
    url: str,
    temp_dir: Path,
    quality: str = "480",
    cookies_file: Path | str | None = None,
) -> tuple[Path, str]:
    """
    Скачивает видео с YouTube или Pinterest с учетом выбранного качества:
    - quality: '360', '480', '720', '1080', 'best'
    - cookies_file: опциональный путь к cookies.txt (для 18+ видео)
    """
    temp_target = temp_dir / f"download_{int(time.time() * 1000)}.mp4"

    # 1. Прямая ссылка MP4
    if is_direct_mp4(url):
        print("[+] Обнаружена прямая ссылка на MP4!")
        download_stream(url, temp_target)
        filename_part = Path(urllib.parse.urlparse(url).path).stem
        return temp_target, filename_part

    # Формируем правило качества для yt-dlp
    if quality.isdigit():
        q_num = int(quality)
        format_selector = (
            f"bestvideo[height<={q_num}][ext=mp4]+bestaudio[ext=m4a]/"
            f"best[height<={q_num}][ext=mp4]/"
            f"bestvideo[height<={q_num}]+bestaudio/"
            f"best[height<={q_num}]/"
            f"best"
        )
    else:
        format_selector = "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/bestvideo+bestaudio/best"

    ffmpeg_exe = get_ffmpeg_exe()
    node_exe = shutil.which("node")

    print(f"[*] Загрузка через yt-dlp (макс. качество: {quality}p)...")
    ydl_opts = {
        "format": format_selector,
        "outtmpl": str(temp_dir / "%(id)s.%(ext)s"),
        "merge_output_format": "mp4",
        "ffmpeg_location": ffmpeg_exe,
        "quiet": False,
        "no_warnings": True,
        "http_headers": BROWSER_HEADERS,
        "js_runtimes": {"node": {"path": node_exe}} if node_exe else {},
        "remote_components": ["ejs:github"],
    }

    # Проверяем наличие cookies.txt
    actual_cookies = cookies_file
    if not actual_cookies:
        default_cookies = SCRIPT_DIR / "cookies.txt"
        if default_cookies.is_file():
            actual_cookies = default_cookies

    if actual_cookies and Path(actual_cookies).is_file():
        ydl_opts["cookiefile"] = str(actual_cookies)
        print(f"[*] Используются куки авторизации: {Path(actual_cookies).name}")

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            title = info.get("title") or info.get("id") or "video"
            filename = ydl.prepare_filename(info)
            actual_file = Path(filename)
            # Если расширение изменилось после merge в mp4
            mp4_file = actual_file.with_suffix(".mp4")
            if mp4_file.is_file():
                return mp4_file, title
            if actual_file.is_file():
                return actual_file, title
    except Exception as ydl_err:
        err_msg = str(ydl_err)
        print(f"[!] yt-dlp сообщил: {err_msg}")

        # Проверяем, является ли это ошибкой 18+ (возрастное ограничение)
        is_age_gate = (
            "sign in to confirm your age" in err_msg.lower()
            or "age-restricted" in err_msg.lower()
            or "inappropriate for some users" in err_msg.lower()
            or "confirm you're not a bot" in err_msg.lower()
        )

        if is_age_gate and not ydl_opts.get("cookiefile"):
            print("\n" + "=" * 70)
            print("[!] ОБНАРУЖЕНО ВОЗРАСТНОЕ ОГРАНИЧЕНИЕ (18+ YouTube)")
            print("YouTube требует подтвержденный аккаунт для этого видео.")
            print("=" * 70)

            # Пробуем автоматически подтянуть куки из установленных браузеров
            for browser_name in ["chrome", "edge", "firefox", "opera", "brave"]:
                print(f"[*] Пробуем авторизоваться через куки браузера '{browser_name}'...")
                try:
                    retry_opts = ydl_opts.copy()
                    retry_opts["cookiesfrombrowser"] = (browser_name, None, None, None)
                    with yt_dlp.YoutubeDL(retry_opts) as ydl_retry:
                        info = ydl_retry.extract_info(url, download=True)
                        title = info.get("title") or info.get("id") or "video"
                        actual_file = Path(ydl_retry.prepare_filename(info))
                        mp4_file = actual_file.with_suffix(".mp4")
                        if mp4_file.is_file():
                            print(f"[+] Авторизация через {browser_name} успешна!")
                            return mp4_file, title
                        if actual_file.is_file():
                            print(f"[+] Авторизация через {browser_name} успешна!")
                            return actual_file, title
                except Exception:
                    continue

            # Если через браузеры тоже не удалось (например, Chrome заблокирован или DPAPI)
            print("\n" + "=" * 70)
            print("[ИНСТРУКЦИЯ] Как скачать это 18+ видео (занимает 30 секунд):")
            print("1. В браузере (Chrome / Edge / Opera / Yandex) установите расширение:")
            print("   'Get cookies.txt LOCALLY' или 'Cookie-Editor'")
            print("2. Зайдите на youtube.com (убедитесь, что вошли в аккаунт с возрастом 18+)")
            print("3. Нажмите на иконку расширения -> Export (в формате cookies.txt / Netscape)")
            print(f"4. Сохраните файл как 'cookies.txt' прямо в папку со скриптом:")
            print(f"   {SCRIPT_DIR / 'cookies.txt'}")
            print("\nСкрипт автоматически найдет cookies.txt и скачает любое 18+ видео!")
            print("=" * 70 + "\n")
            raise RuntimeError("Видео 18+ требует файл cookies.txt. Положите его в папку со скриптом (инструкция выше).")

    # 3. Если это Pinterest и yt-dlp не справился — резервный поиск
    if is_pinterest_url(url):
        print("[*] Переходим к резервному веб-поиску видео...")
        direct_url, page_title = scrape_video_from_pinterest_page(url)
        if direct_url:
            print(f"[+] Найдено видео на странице: {direct_url[:70]}...")
            download_stream(direct_url, temp_target)
            title = page_title or "pinterest_video"
            return temp_target, title

    raise RuntimeError("Не удалось скачать видео по указанной ссылке. Проверьте адрес.")


def convert_to_gif(
    video_path: Path,
    output_gif: Path,
    fps: int = 20,
    width: int = 480,
    speed: float = 1.0,
    start_time: str | None = None,
    end_time: str | None = None,
) -> bool:
    """
    Выполняет двухпроходную конвертацию фрагмента/всего видео в качественный GIF через FFmpeg.
    """
    ffmpeg_exe = get_ffmpeg_exe()

    filter_parts = []
    if speed != 1.0 and speed > 0:
        pts_factor = 1.0 / speed
        filter_parts.append(f"setpts={pts_factor:.4f}*PTS")

    filter_parts.append(f"fps={fps}")

    if width > 0:
        filter_parts.append(f"scale=min({width}\\,iw):-2:flags=lanczos")
    else:
        filter_parts.append("scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos")

    base_filter = ",".join(filter_parts)
    complex_filter = (
        f"[0:v] {base_filter},split [a][b];"
        f"[a] palettegen=stats_mode=diff:reserve_transparent=0 [p];"
        f"[b][p] paletteuse=dither=bayer:bayer_scale=5"
    )

    cmd = [ffmpeg_exe, "-y"]
    if start_time:
        cmd.extend(["-ss", start_time])
    if end_time:
        cmd.extend(["-to", end_time])

    cmd.extend([
        "-i", str(video_path),
        "-filter_complex", complex_filter,
        str(output_gif),
    ])

    trim_info = f" (отрезок: {start_time or 'начало'} - {end_time or 'конец'})" if (start_time or end_time) else ""
    print(f"[*] Конвертация в GIF: {fps} FPS, макс. ширина {width if width > 0 else 'оригинал'}px{trim_info}...")
    start_clock = time.time()

    import subprocess
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        print(f"[ОШИБКА FFmpeg]\n{proc.stderr}")
        return False

    elapsed = time.time() - start_clock
    gif_size_mb = output_gif.stat().st_size / (1024 * 1024)
    print(f"[+] GIF успешно создан за {elapsed:.1f} сек! Размер: {gif_size_mb:.2f} МБ")
    return True


def save_trimmed_video(
    src_video: Path,
    target_video: Path,
    start_time: str | None = None,
    end_time: str | None = None,
) -> bool:
    """Сохраняет видеофайл MP4 (с обрезкой по времени, если указана)."""
    ffmpeg_exe = get_ffmpeg_exe()

    if not start_time and not end_time:
        # Простое быстрое копирование без перекодирования
        shutil.copy2(src_video, target_video)
        size_mb = target_video.stat().st_size / (1024 * 1024)
        print(f"[+] Видео сохранено: {target_video.name} ({size_mb:.2f} МБ)")
        return True

    # Точная обрезка с сохранением качества и аудио
    cmd = [ffmpeg_exe, "-y"]
    if start_time:
        cmd.extend(["-ss", start_time])
    if end_time:
        cmd.extend(["-to", end_time])

    cmd.extend([
        "-i", str(src_video),
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "20",
        "-c:a", "aac",
        "-b:a", "192k",
        str(target_video),
    ])

    print(f"[*] Обрезка видео ({start_time or '00:00'} - {end_time or 'конец'})...")
    import subprocess
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        print(f"[ОШИБКА обрезки видео]\n{proc.stderr}")
        return False

    size_mb = target_video.stat().st_size / (1024 * 1024)
    print(f"[+] Видео MP4 сохранено: {target_video.name} ({size_mb:.2f} МБ)")
    return True


def process_link(
    raw_url: str,
    output_dir: Path,
    mode: str = "gif",          # 'gif', 'video', 'both'
    quality: str = "480",       # '360', '480', '720', '1080', 'best'
    fps: int = 20,
    width: int = 480,
    speed: float = 1.0,
    trim_str: str | None = None,
    cookies_file: Path | str | None = None,
) -> bool:
    """
    Полный цикл: ссылка -> скачивание -> обработка (GIF / MP4 / оба) -> сохранение.
    """
    clean_url = resolve_url(raw_url)
    output_dir.mkdir(parents=True, exist_ok=True)
    start_time, end_time = parse_time_trim(trim_str)

    # Определяем ширину GIF в зависимости от качества (если ширина не задана явно)
    gif_width = width
    if width == 480 and quality in ("720", "1080", "360"):
        if quality == "360":
            gif_width = 360
        elif quality == "720":
            gif_width = 720
        elif quality == "1080":
            gif_width = 1080

    with tempfile.TemporaryDirectory() as temp_dir_str:
        temp_dir = Path(temp_dir_str)
        try:
            # 1. Скачиваем исходный файл в нужном качестве
            video_file, title = download_video(
                clean_url,
                temp_dir,
                quality=quality,
                cookies_file=cookies_file,
            )

            # 2. Формируем префикс и имя файла
            is_yt = is_youtube_url(clean_url)
            prefix = "yt" if is_yt else "pin"

            # Пытаемся извлечь id
            pin_id_match = re.search(r"/pin/(\d+)", clean_url)
            if pin_id_match:
                prefix = f"pin_{pin_id_match.group(1)}"

            base_name = f"{prefix}_{sanitize_filename(title)}"
            timestamp = int(time.time())

            saved_any = False

            # Сохраняем MP4
            if mode in ("video", "both"):
                mp4_name = f"{base_name}_{quality}p.mp4" if quality.isdigit() else f"{base_name}.mp4"
                target_mp4 = output_dir / mp4_name
                if target_mp4.exists():
                    target_mp4 = output_dir / f"{base_name}_{timestamp}.mp4"

                if save_trimmed_video(video_file, target_mp4, start_time, end_time):
                    saved_any = True

            # Сохраняем GIF
            if mode in ("gif", "both"):
                gif_name = f"{base_name}.gif"
                target_gif = output_dir / gif_name
                if target_gif.exists():
                    target_gif = output_dir / f"{base_name}_{timestamp}.gif"

                if convert_to_gif(
                    video_path=video_file,
                    output_gif=target_gif,
                    fps=fps,
                    width=gif_width,
                    speed=speed,
                    start_time=start_time,
                    end_time=end_time,
                ):
                    saved_any = True

            if saved_any:
                print(f"\n[+] Готово! Все файлы сохранены в папку:\n    {output_dir.resolve()}\n")
                return True
            return False

        except Exception as err:
            print(f"\n[ОШИБКА] Не удалось обработать видео: {err}\n")
            return False


def interactive_mode(output_dir: Path, default_fps: int = 20):
    """Интерактивный диалоговый режим."""
    print("=" * 62)
    print("     Video & GIF Downloader (Pinterest + YouTube)")
    print("=" * 62)
    print(f"Папка сохранения: {output_dir.resolve()}")
    print("Поддерживаемые ссылки:")
    print("  - Pinterest: https://pin.it/..., https://pinterest.com/pin/...")
    print("  - YouTube: видео, shorts, youtu.be")
    print("  - Прямые MP4 ссылки")
    print("=" * 62)
    print("Для выхода введите 'q' или 'exit'.\n")

    while True:
        try:
            url_input = input(">> Вставьте ссылку на видео: ").strip()
            if not url_input:
                continue
            if url_input.lower() in ("q", "quit", "exit", "й"):
                print("Выход из программы. До встречи!")
                break

            # 1. Выбор формата
            print("\n[?] В каком формате сохранить?")
            print("    [1] GIF (по умолчанию)")
            print("    [2] MP4 видео со звуком")
            print("    [3] И GIF, и MP4 видео")
            format_choice = input("    Выберите [1-3, Enter=1]: ").strip()
            if format_choice == "2":
                mode = "video"
            elif format_choice == "3":
                mode = "both"
            else:
                mode = "gif"

            # 2. Выбор качества
            print("\n[?] Качество:")
            if mode == "video":
                print("    [1] 1080p Full HD (по умолчанию)")
                print("    [2] 720p HD")
                print("    [3] 480p")
                print("    [4] 360p")
                print("    [5] Максимальное доступное (4K/2K/best)")
                q_choice = input("    Выберите качество [1-5, Enter=1]: ").strip()
                q_map = {"1": "1080", "2": "720", "3": "480", "4": "360", "5": "best"}
                quality = q_map.get(q_choice, "1080")
            elif mode == "both":
                print("    [1] 720p (по умолчанию)")
                print("    [2] 1080p Full HD")
                print("    [3] 480p")
                print("    [4] Максимальное")
                q_choice = input("    Выберите качество [1-4, Enter=1]: ").strip()
                q_map = {"1": "720", "2": "1080", "3": "480", "4": "best"}
                quality = q_map.get(q_choice, "720")
            else:
                print("    [1] 480p (Рекомендуется для GIF - отличный вес/качество)")
                print("    [2] 720p HD (Высокое качество, больше вес)")
                print("    [3] 360p (Легкий / компактный GIF)")
                print("    [4] 1080p Full HD")
                print("    [5] Исходное (без масштабирования)")
                q_choice = input("    Выберите качество [1-5, Enter=1]: ").strip()
                q_map = {"1": "480", "2": "720", "3": "360", "4": "1080", "5": "best"}
                quality = q_map.get(q_choice, "480")

            # 3. Обрезка по времени
            print("\n[?] Отрезок времени (Enter = всё видео, либо введите '0:10-0:25'):")
            trim_input = input("    Отрезок: ").strip()
            trim_str = trim_input if trim_input else None

            # Запуск обработки
            print()
            process_link(
                raw_url=url_input,
                output_dir=output_dir,
                mode=mode,
                quality=quality,
                fps=default_fps,
                trim_str=trim_str,
            )
            print("-" * 62)

        except KeyboardInterrupt:
            print("\nВыход из программы.")
            break
        except Exception as e:
            print(f"[!] Ошибка: {e}")


def main():
    parser = argparse.ArgumentParser(
        description="Универсальный загрузчик видео и GIF с Pinterest и YouTube."
    )
    parser.add_argument(
        "url",
        nargs="?",
        default=None,
        help="Ссылка на видео (Pinterest, YouTube, или прямой MP4)",
    )
    parser.add_argument(
        "--mode",
        "-m",
        choices=["gif", "video", "both"],
        default="gif",
        help="Режим: 'gif' (по умолчанию), 'video' (MP4 со звуком), 'both' (оба)",
    )
    parser.add_argument(
        "--quality",
        "-q",
        choices=["360", "480", "720", "1080", "best"],
        default=None,
        help="Качество скачивания (по умолчанию: 480 для GIF, 1080 для video)",
    )
    parser.add_argument(
        "--trim",
        "-t",
        default=None,
        help="Отрезок времени, например: '00:10-00:25' или '5-15'",
    )
    parser.add_argument(
        "--fps",
        type=int,
        default=20,
        help="Частота кадров GIF (по умолчанию: 20)",
    )
    parser.add_argument(
        "--width",
        type=int,
        default=480,
        help="Максимальная ширина GIF в px (по умолчанию: 480)",
    )
    parser.add_argument(
        "--speed",
        type=float,
        default=1.0,
        help="Множитель скорости (например: 1.5 для ускорения)",
    )
    parser.add_argument(
        "--cookies",
        "-c",
        default=None,
        help="Путь к файлу cookies.txt для авторизации 18+ видео YouTube",
    )
    parser.add_argument(
        "--output-dir",
        "-o",
        default=str(SCRIPT_DIR),
        help=f"Папка сохранения (по умолчанию: {SCRIPT_DIR})",
    )

    args = parser.parse_args()
    out_dir = Path(args.output_dir)

    # Качество по умолчанию, если не задано
    quality = args.quality
    if not quality:
        quality = "1080" if args.mode == "video" else ("720" if args.mode == "both" else "480")

    if args.url:
        process_link(
            raw_url=args.url,
            output_dir=out_dir,
            mode=args.mode,
            quality=quality,
            fps=args.fps,
            width=args.width,
            speed=args.speed,
            trim_str=args.trim,
            cookies_file=args.cookies,
        )
    else:
        interactive_mode(output_dir=out_dir, default_fps=args.fps)


if __name__ == "__main__":
    main()
