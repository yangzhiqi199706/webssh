'use strict';

// build-docx.js —— 把"安装与卸载手册.md"渲染成专业 .docx
// 设计要点：
//   1. 中文宋体 + 英文 Calibri + 等宽 Consolas（通过 IFontAttributesProperties 分别指定）
//   2. ## → Heading 1（强制分页 + 深蓝色），### → Heading 2
//   3. Markdown 表格 → Word 表格（首行底色 + 居中）
//   4. 代码块用浅灰底色 + 等宽字体
//   5. 行内 `code` 用等宽 + 暖红色（不加底色，避免兼容性问题）
//   6. 页码（第 N 页 / 共 M 页）+ 页眉
//   7. 封面页（标题 + 副标题 + 日期）

const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, LevelFormat,
  BorderStyle, WidthType, ShadingType, VerticalAlign,
  PageNumber, PageBreak, HeadingLevel,
} = require('docx');

const ROOT = __dirname;
const SRC = path.join(ROOT, '安装与卸载手册.md');
const OUT = path.join(ROOT, 'dist', '安装与卸载手册.docx');

// ---------- 字体常量 ----------
const FONT_HAN = '宋体';
const FONT_LAT = 'Calibri';
const FONT_MONO = 'Consolas';

const fontNormal = { ascii: FONT_LAT, hAnsi: FONT_LAT, eastAsia: FONT_HAN, cs: FONT_LAT };
const fontMono = { ascii: FONT_MONO, hAnsi: FONT_MONO, eastAsia: FONT_HAN, cs: FONT_MONO };

const SIZE_BODY = 22;  // 11pt
const SIZE_CODE = 18;  // 9pt
const SIZE_H1 = 32;    // 16pt
const SIZE_H2 = 26;    // 13pt
const SIZE_FOOTER = 18; // 9pt

const COLOR_H1 = '1F4E79';
const COLOR_H2 = '2E74B5';
const COLOR_CODE_INLINE = 'C7254E';
const COLOR_CODE_BLOCK = '1F1F1F';
const COLOR_MUTED = '808080';
const BG_CODE = 'F5F5F5';
const BG_TABLE_HEADER = 'D9E2F3';

// ---------- 通用 helper ----------

function txt(text, opts = {}) {
  return new TextRun({
    text,
    font: opts.font || fontNormal,
    size: opts.size || SIZE_BODY,
    bold: opts.bold || false,
    color: opts.color,
  });
}

function codeRun(text, opts = {}) {
  return new TextRun({
    text,
    font: fontMono,
    size: opts.size || (SIZE_CODE + 2),  // 行内 code 略大，与正文协调
    color: opts.color || COLOR_CODE_INLINE,
  });
}

// 行内：解析 **bold** 和 `code`
function parseInline(text) {
  const runs = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end !== -1) {
        runs.push(txt(text.substring(i + 2, end), { bold: true }));
        i = end + 2;
        continue;
      }
    }
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        runs.push(codeRun(text.substring(i + 1, end)));
        i = end + 1;
        continue;
      }
    }
    // 找下一个 ** 或 `
    let next = text.length;
    const ds = text.indexOf('**', i);
    const cs = text.indexOf('`', i);
    if (ds !== -1 && ds < next) next = ds;
    if (cs !== -1 && cs < next) next = cs;
    if (next === i) {
      // 标记字符未闭合，按普通字符处理
      runs.push(txt(text[i]));
      i++;
    } else {
      runs.push(txt(text.substring(i, next)));
      i = next;
    }
  }
  return runs.length ? runs : [txt('')];
}

// ---------- 块级元素 ----------

function heading1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    pageBreakBefore: true,
    children: parseInline(text).map(r => {
      // 用 H1 字号/颜色覆盖 parseInline 给出的默认
      return new TextRun({
        text: r.options ? r.options.text : '',
        font: fontNormal, size: SIZE_H1, bold: true, color: COLOR_H1,
      });
    }),
    spacing: { before: 360, after: 180 },
  });
}

function heading2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [new TextRun({
      text, font: fontNormal, size: SIZE_H2, bold: true, color: COLOR_H2,
    })],
    spacing: { before: 240, after: 120 },
  });
}

function paraNormal(text) {
  return new Paragraph({
    children: parseInline(text),
    spacing: { before: 60, after: 120, line: 320 },
  });
}

function codeBlockParagraph(line, opts = {}) {
  return new Paragraph({
    children: [new TextRun({
      text: line === '' ? ' ' : line,
      font: fontMono,
      size: SIZE_CODE,
      color: COLOR_CODE_BLOCK,
    })],
    shading: { fill: BG_CODE, type: ShadingType.CLEAR },
    spacing: { before: 0, after: 0, line: 280 },
    indent: { left: 280 },
    border: opts.firstLine ? {
      top: { style: BorderStyle.SINGLE, size: 4, color: 'D0D0D0' },
    } : opts.lastLine ? {
      bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D0D0D0' },
    } : undefined,
  });
}

function listItem(text, ordered = false, level = 0) {
  return new Paragraph({
    numbering: { reference: ordered ? 'numbers' : 'bullets', level },
    children: parseInline(text),
    spacing: { before: 40, after: 80, line: 300 },
  });
}

function quoteParagraph(text) {
  return new Paragraph({
    children: parseInline(text),
    spacing: { before: 100, after: 120, line: 320 },
    indent: { left: 360 },
    shading: { fill: 'FFF7E6', type: ShadingType.CLEAR },
    border: {
      left: { style: BorderStyle.SINGLE, size: 16, color: 'F0A020', space: 8 },
    },
  });
}

const cellBorder = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' };
const cellBorders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };

function buildTable(rows) {
  const colCount = Math.max(...rows.map(r => r.length));
  // 把所有行补齐到 colCount
  rows = rows.map(r => {
    while (r.length < colCount) r.push('');
    return r;
  });
  const totalWidth = 9000;
  const colWidth = Math.floor(totalWidth / colCount);
  const colWidths = Array(colCount).fill(colWidth);
  colWidths[colCount - 1] = totalWidth - colWidth * (colCount - 1);

  return new Table({
    width: { size: totalWidth, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: rows.map((row, rowIdx) => new TableRow({
      tableHeader: rowIdx === 0,
      children: row.map((cell, colIdx) => {
        const cellRuns = parseInline(cell);
        // 表头加粗
        if (rowIdx === 0) {
          cellRuns.forEach(r => {
            if (r.options) r.options.bold = true;
          });
        }
        return new TableCell({
          borders: cellBorders,
          width: { size: colWidths[colIdx], type: WidthType.DXA },
          shading: rowIdx === 0
            ? { fill: BG_TABLE_HEADER, type: ShadingType.CLEAR }
            : undefined,
          margins: { top: 80, bottom: 80, left: 140, right: 140 },
          verticalAlign: VerticalAlign.CENTER,
          children: [new Paragraph({
            children: cellRuns,
            spacing: { before: 0, after: 0, line: 280 },
            alignment: rowIdx === 0 ? AlignmentType.CENTER : AlignmentType.LEFT,
          })],
        });
      }),
    })),
  });
}

// ---------- markdown 解析 ----------

function parseMarkdown(md) {
  const lines = md.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 空行
    if (line.trim() === '') {
      i++;
      continue;
    }

    // 水平线 / 分隔
    if (/^-{3,}$/.test(line.trim())) {
      i++;
      continue;
    }

    // 文档主标题（# ）— 跳过，封面会单独处理
    if (line.startsWith('# ') && !line.startsWith('## ')) {
      i++;
      continue;
    }

    // ## → H1
    if (line.startsWith('## ')) {
      blocks.push(heading1(line.slice(3).trim()));
      i++;
      continue;
    }

    // ### → H2
    if (line.startsWith('### ')) {
      blocks.push(heading2(line.slice(4).trim()));
      i++;
      continue;
    }

    // 代码块
    if (line.trimStart().startsWith('```')) {
      i++;
      const codeLines = [];
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // 跳过结尾 ```
      codeLines.forEach((cl, idx) => blocks.push(codeBlockParagraph(cl, {
        firstLine: idx === 0,
        lastLine: idx === codeLines.length - 1,
      })));
      // 后留白
      blocks.push(new Paragraph({ children: [txt('')], spacing: { before: 60, after: 60 } }));
      continue;
    }

    // 表格
    if (line.startsWith('|')) {
      const tableLines = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      const sepIdx = tableLines.findIndex(l => /^\|[\s\-:|]+\|?\s*$/.test(l));
      const headerLines = sepIdx > 0 ? tableLines.slice(0, sepIdx) : [tableLines[0]];
      const bodyLines = sepIdx > 0 ? tableLines.slice(sepIdx + 1) : tableLines.slice(1);
      const parseCells = (l) => {
        let s = l.trim();
        if (s.startsWith('|')) s = s.slice(1);
        if (s.endsWith('|')) s = s.slice(0, -1);
        return s.split('|').map(c => c.trim());
      };
      const rows = [...headerLines, ...bodyLines]
        .filter(l => l.trim() !== '')
        .map(parseCells);
      if (rows.length > 0) blocks.push(buildTable(rows));
      blocks.push(new Paragraph({ children: [txt('')], spacing: { before: 60, after: 60 } }));
      continue;
    }

    // 引用块（> 开头），可跨多行
    if (line.startsWith('> ') || line === '>') {
      const quoteLines = [];
      while (i < lines.length && (lines[i].startsWith('> ') || lines[i] === '>' || lines[i].startsWith('>'))) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push(quoteParagraph(quoteLines.join(' ')));
      continue;
    }

    // 编号列表
    if (/^\d+\.\s/.test(line)) {
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        blocks.push(listItem(lines[i].replace(/^\d+\.\s+/, ''), true));
        i++;
      }
      continue;
    }

    // 项目符号列表
    if (line.startsWith('- ')) {
      while (i < lines.length && lines[i].startsWith('- ')) {
        blocks.push(listItem(lines[i].slice(2), false));
        i++;
      }
      continue;
    }

    // 普通段落（合并连续非空非特殊行）
    const paraLines = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') break;
      if (l.startsWith('## ') || l.startsWith('### ')) break;
      if (l.trimStart().startsWith('```')) break;
      if (l.startsWith('|')) break;
      if (l.startsWith('> ') || l === '>') break;
      if (/^\d+\.\s/.test(l)) break;
      if (l.startsWith('- ')) break;
      if (/^-{3,}$/.test(l.trim())) break;
      paraLines.push(l);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push(paraNormal(paraLines.join(' ')));
    }
  }

  return blocks;
}

// ---------- 封面 ----------

function coverPage() {
  return [
    // 顶部留白
    new Paragraph({ children: [txt('')], spacing: { before: 2400 } }),

    // 主标题（两行）
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({
        text: 'WebSSH + 协议助手',
        font: fontNormal, size: 64, bold: true, color: COLOR_H1,
      })],
      spacing: { before: 0, after: 200 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({
        text: '安装与卸载手册',
        font: fontNormal, size: 56, bold: true, color: COLOR_H1,
      })],
      spacing: { before: 0, after: 600 },
    }),

    // 装饰横线
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: '', font: fontNormal })],
      border: {
        bottom: { style: BorderStyle.SINGLE, size: 16, color: COLOR_H1, space: 4 },
      },
      spacing: { before: 0, after: 800 },
    }),

    // 副标题
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({
        text: '适用版本',
        font: fontNormal, size: 24, color: '595959',
      })],
      spacing: { before: 0, after: 100 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({
        text: 'v1.0.0-20260522042433',
        font: fontMono, size: 30, bold: true, color: COLOR_H1,
      })],
      spacing: { before: 0, after: 1000 },
    }),

    // 日期
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: '编制日期：', font: fontNormal, size: 24, color: '595959' }),
        new TextRun({ text: '2026-05-22', font: fontMono, size: 26, bold: true, color: '595959' }),
      ],
      spacing: { before: 0, after: 0 },
    }),
  ];
}

// ---------- 主流程 ----------

const md = fs.readFileSync(SRC, 'utf8');
const blocks = parseMarkdown(md);

const doc = new Document({
  creator: 'WebSSH 项目',
  title: 'WebSSH + 协议助手 - 安装与卸载手册',
  description: '部署运维同事使用',
  styles: {
    default: {
      document: {
        run: { font: fontNormal, size: SIZE_BODY },
        paragraph: { spacing: { line: 320 } },
      },
    },
    paragraphStyles: [
      {
        id: 'Heading1', name: 'Heading 1',
        basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: SIZE_H1, bold: true, font: fontNormal, color: COLOR_H1 },
        paragraph: { spacing: { before: 360, after: 180 }, outlineLevel: 0 },
      },
      {
        id: 'Heading2', name: 'Heading 2',
        basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: SIZE_H2, bold: true, font: fontNormal, color: COLOR_H2 },
        paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1 },
      },
    ],
  },
  numbering: {
    config: [
      {
        reference: 'bullets',
        levels: [{
          level: 0,
          format: LevelFormat.BULLET,
          text: '•',
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      },
      {
        reference: 'numbers',
        levels: [{
          level: 0,
          format: LevelFormat.DECIMAL,
          text: '%1.',
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      },
    ],
  },
  sections: [{
    properties: {
      page: {
        size: { width: 11906, height: 16838 }, // A4
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
      },
    },
    headers: {
      default: new Header({
        children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({
            text: 'WebSSH + 协议助手 安装与卸载手册',
            font: fontNormal, size: SIZE_FOOTER, color: COLOR_MUTED,
          })],
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF', space: 4 } },
        })],
      }),
    },
    footers: {
      default: new Footer({
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({ text: '第 ', font: fontNormal, size: SIZE_FOOTER, color: COLOR_MUTED }),
            new TextRun({ children: [PageNumber.CURRENT], font: fontNormal, size: SIZE_FOOTER, color: COLOR_MUTED, bold: true }),
            new TextRun({ text: ' 页 / 共 ', font: fontNormal, size: SIZE_FOOTER, color: COLOR_MUTED }),
            new TextRun({ children: [PageNumber.TOTAL_PAGES], font: fontNormal, size: SIZE_FOOTER, color: COLOR_MUTED, bold: true }),
            new TextRun({ text: ' 页', font: fontNormal, size: SIZE_FOOTER, color: COLOR_MUTED }),
          ],
        })],
      }),
    },
    children: [...coverPage(), ...blocks],
  }],
});

Packer.toBuffer(doc).then(buffer => {
  if (!fs.existsSync(path.dirname(OUT))) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
  }
  fs.writeFileSync(OUT, buffer);
  console.log('✅ 已生成:', OUT);
  console.log('   大小:', (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB');
}).catch(err => {
  console.error('生成失败:', err);
  process.exit(1);
});
