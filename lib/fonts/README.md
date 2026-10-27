# Report fonts

These fonts are bundled so adverse-media reports can render source titles and excerpts in their original scripts without contacting a remote font service.

| File | Upstream | License |
| --- | --- | --- |
| NotoSans.ttf | [Google Fonts Noto Sans](https://github.com/google/fonts/tree/main/ofl/notosans) | OFL-NotoSans.txt |
| NotoSansArabic.ttf | [Google Fonts Noto Sans Arabic](https://github.com/google/fonts/tree/main/ofl/notosansarabic) | OFL-NotoSansArabic.txt |
| NotoSansDevanagari.ttf | [Google Fonts Noto Sans Devanagari](https://github.com/google/fonts/tree/main/ofl/notosansdevanagari) | OFL-NotoSansDevanagari.txt |
| NotoSansCJKsc-Regular.otf | [Noto CJK Sans](https://github.com/notofonts/noto-cjk/tree/main/Sans/OTF/SimplifiedChinese) | OFL-NotoSansCJK.txt |

The renderer embeds script fonts only when a report uses them. The CJK font must be embedded in full because the current fontkit subset path drops some glyphs; reports containing CJK text are therefore larger.
