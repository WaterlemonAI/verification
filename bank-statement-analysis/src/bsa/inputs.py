"""Bounded local input normalization. The canonical parser receives a PDF."""

import io
import warnings


MEDIA_TYPES = {"application/pdf", "image/png", "image/jpeg", "image/tiff"}


def normalize_inputs(files: list[tuple[str, bytes]], *, max_pages: int = 100,
                     max_pixels_per_page: int = 40_000_000) -> bytes:
    if not files or len(files) > max_pages:
        raise ValueError("PAGE_LIMIT_EXCEEDED")
    if any(kind not in MEDIA_TYPES for kind, _ in files):
        raise ValueError("UNSUPPORTED_FILE_TYPE")
    if len(files) == 1 and files[0][0] == "application/pdf":
        return files[0][1]
    if any(kind == "application/pdf" for kind, _ in files):
        raise ValueError("INVALID_FILE_BUNDLE")
    try:
        import pymupdf
        from PIL import Image, UnidentifiedImageError
    except ImportError as error:
        raise ValueError("IMAGE_PROCESSING_UNAVAILABLE") from error
    combined = pymupdf.open()
    for kind, data in files:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                image = Image.open(io.BytesIO(data))
                frames = getattr(image, "n_frames", 1)
                if combined.page_count + frames > max_pages:
                    raise ValueError("PAGE_LIMIT_EXCEEDED")
                for frame in range(frames):
                    image.seek(frame)
                    width, height = image.size
                    if width <= 0 or height <= 0 or width * height > max_pixels_per_page:
                        raise ValueError("IMAGE_PIXEL_LIMIT_EXCEEDED")
                    # Convert each frame to RGB PNG so a TIFF bundle keeps page order.
                    converted = image.convert("RGB")
                    buffer = io.BytesIO()
                    converted.save(buffer, format="PNG")
                    page_image = pymupdf.open(stream=buffer.getvalue(), filetype="png")
                    page_pdf = pymupdf.open(stream=page_image.convert_to_pdf(), filetype="pdf")
                    combined.insert_pdf(page_pdf)
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
            raise ValueError("INVALID_IMAGE") from error
    return combined.tobytes(garbage=4, deflate=True)
