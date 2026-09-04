import express, { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';

const app = express();
const PORT = 3000;
const UPLOAD_DIR = process.env.NODE_ENV === 'production' ? '/data' : path.join(__dirname, 'uploads');
const METADATA_FILE = process.env.NODE_ENV === 'production' ? path.join('/data', 'metadata.json') : path.join(__dirname, 'metadata.json');

// 定数設定
const MAX_FILE_SIZE = 300 * 1024 * 1024; // 300MB
const EXPIRY_DAYS = 7;
const MAX_CONCURRENT_DOWNLOADS = 100;

let currentDownloads = 0;

interface FileMeta {
    id: string;
    originalName: string;
    filename: string;
    size: number;
    password?: string;
    expiresAt: number;
}

// アップロードディレクトリの作成
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// メタデータの読み込み
function loadMetadata(): Record<string, FileMeta> {
    if (fs.existsSync(METADATA_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'));
        } catch {
            return {};
        }
    }
    return {};
}

// メタデータの保存
function saveMetadata(data: Record<string, FileMeta>) {
    fs.writeFileSync(METADATA_FILE, JSON.stringify(data, null, 2));
}

// 期限切れファイルの自動クリーンアップ
function cleanupExpiredFiles() {
    const metadata = loadMetadata();
    const now = Date.now();
    let updated = false;

    for (const id in metadata) {
        if (metadata[id].expiresAt < now) {
            const filePath = path.join(UPLOAD_DIR, metadata[id].filename);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            delete metadata[id];
            updated = true;
        }
    }
    if (updated) {
        saveMetadata(metadata);
    }
}

// 定期的にクリーンアップを実行 (1時間ごと)
setInterval(cleanupExpiredFiles, 60 * 60 * 1000);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 短縮アドレス（ダウンロード画面）用のルーティング
app.get('/dl/:id', (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'dl.html'));
});

// ファイルアップロード処理
app.post('/api/upload', (req: Request, res: Response) => {
    cleanupExpiredFiles();

    const originalName = req.headers['x-file-name'] ? decodeURIComponent(req.headers['x-file-name'] as string) : 'file.zip';
    const password = req.headers['x-file-password'] as string | undefined;

    // 拡張子チェック (ZIP方式限定)
    if (!originalName.toLowerCase().endsWith('.zip')) {
        return res.status(400).json({ error: 'ZIPファイルでないファイルはZIPファイルおいてください' });
    }

    const fileId = uuidv4().substring(0, 8); // 短縮アドレス用ID
    const savedFilename = `${fileId}_${Date.now()}.zip`;
    const filePath = path.join(UPLOAD_DIR, savedFilename);

    let fileSize = 0;
    const writeStream = fs.createWriteStream(filePath);
    let sizeExceeded = false;

    req.on('data', (chunk) => {
        fileSize += chunk.length;
        if (fileSize > MAX_FILE_SIZE) {
            sizeExceeded = true;
            writeStream.destroy();
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            if (!res.headersSent) {
                res.status(400).json({ error: '３００M以上のファイルは扱えませんとエラーが表示されます。' });
            }
        }
    });

    req.pipe(writeStream);

    writeStream.on('finish', () => {
        if (sizeExceeded) return;

        const metadata = loadMetadata();
        const expiresAt = Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000;

        metadata[fileId] = {
            id: fileId,
            originalName,
            filename: savedFilename,
            size: fileSize,
            password: password ? password : undefined,
            expiresAt
        };

        saveMetadata(metadata);

        res.json({
            success: true,
            downloadUrl: `/dl/${fileId}`
        });
    });

    writeStream.on('error', (err) => {
        if (!res.headersSent) {
            res.status(500).json({ error: 'アップロードに失敗しました。' });
        }
    });
});

// ファイル情報・パスワード確認用API
app.post('/api/check/:id', (req: Request, res: Response) => {
    cleanupExpiredFiles();
    const id = String(req.params.id); // 明示的にstringに変換
    const { password } = req.body;
    const metadata = loadMetadata();

    const meta = metadata[id];
    if (!meta) {
        return res.status(404).json({ error: 'ファイルが見つからないか、期限切れです。' });
    }

    if (meta.password && meta.password !== password) {
        return res.status(401).json({ error: 'パスワードが違います。' });
    }

    res.json({ success: true, originalName: meta.originalName, size: meta.size });
});

// ダウンロード処理（同時アクセス制限100人対応）
app.get('/api/download/:id', (req: Request, res: Response) => {
    cleanupExpiredFiles();

    if (currentDownloads >= MAX_CONCURRENT_DOWNLOADS) {
        return res.status(503).json({ error: '少し経ってから再アクセスください。' });
    }

    const id = String(req.params.id); // 明示的にstringに変換
    const password = req.query.pwd as string | undefined;
    const metadata = loadMetadata();
    const meta = metadata[id];

    if (!meta) {
        return res.status(404).json({ error: 'ファイルが存在しないか、期限切れです。' });
    }

    if (meta.password && meta.password !== password) {
        return res.status(401).json({ error: 'パスワード認証が必要です。' });
    }

    const filePath = path.join(UPLOAD_DIR, meta.filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'ファイル本体が見つかりません。' });
    }

    currentDownloads++;
    res.download(filePath, meta.originalName, (err) => {
        currentDownloads--;
    });
});

app.listen(PORT, () => {
    console.log(`えりのすとれーじ が起動しました: http://localhost:${PORT}`);
});