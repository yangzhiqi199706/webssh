const IMAGE_EXT_REGEXP = /\.(png|jpe?g|gif|bmp|svg|webp)$/i;
const TXT_EXT_REGEXP = /\.txt$/i;

const normalizeDirectory = (directory = "") =>
    directory.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");

const parseDirectoryLinks = (html = "") => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const fileNames = new Set();

    doc.querySelectorAll("a[href]").forEach((anchor) => {
        let href = anchor.getAttribute("href") || "";
        if (!href) return;

        href = href.split("#")[0].split("?")[0].trim();
        if (!href || href === "." || href === ".." || href === "./" || href === "../") return;
        if (href.endsWith("/")) return;

        try {
            href = decodeURIComponent(href);
        } catch (error) {
            // Keep raw href when decodeURIComponent fails.
        }

        if (/^https?:\/\//i.test(href)) {
            try {
                href = new URL(href).pathname;
            } catch (error) {
                return;
            }
        }

        const fileName = href.split("/").filter(Boolean).pop();
        if (fileName) {
            fileNames.add(fileName);
        }
    });

    return Array.from(fileNames).sort((a, b) =>
        a.localeCompare(b, "zh-Hans-CN", { numeric: true, sensitivity: "base" })
    );
};

export const listDirectoryFiles = async (directory, matcher) => {
    const normalized = normalizeDirectory(directory);
    if (!normalized) return [];

    try {
        const response = await fetch(`/${normalized}/`, { cache: "no-store" });
        if (!response.ok) return [];
        const html = await response.text();
        const files = parseDirectoryLinks(html);
        return typeof matcher === "function" ? files.filter((file) => matcher(file)) : files;
    } catch (error) {
        return [];
    }
};

export const listImageFilesFromDirectory = (directory) =>
    listDirectoryFiles(directory, (file) => IMAGE_EXT_REGEXP.test(file));

export const listTxtFilesFromDirectory = (directory) =>
    listDirectoryFiles(directory, (file) => TXT_EXT_REGEXP.test(file));

export const readTextFileFromPublicDir = async (directory, fileName) => {
    const normalized = normalizeDirectory(directory);
    if (!normalized || !fileName) return "";

    try {
        const response = await fetch(`/${normalized}/${encodeURIComponent(fileName)}`, {
            cache: "no-store",
        });
        if (!response.ok) return "";
        return await response.text();
    } catch (error) {
        return "";
    }
};

export const removeFileExt = (fileName = "") => fileName.replace(/\.[^.]+$/, "");

export const readPageModuleByName = async (pageName) =>
    readTextFileFromPublicDir("Images/page", `${pageName}.txt`);
