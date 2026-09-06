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
// 7日間（604,800,000ミリ秒）
const EXPIRY_TIME_MS = 7 * 24 * 60 * 60 * 1000; 
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

// メタデータの安全な読み込み
function loadMetadata(): Record<string, FileMeta> {
    try {
        if (fs.existsSync(METADATA_FILE)) {
            const data = fs.readFileSync(METADATA_FILE, 'utf-8');
            return data ? JSON.parse(data) : {};
        } else {
            const initialData = {};
            fs.writeFileSync(METADATA_FILE, JSON.stringify(initialData, null, 2));
            return initialData;
        }
    } catch (err) {
        console.error('メタデータの読み込みエラー:', err);
        return {};
    }
}

// メタデータの安全な保存
function saveMetadata(data: Record<string, FileMeta>) {
    try {
        fs.writeFileSync(METADATA_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('メタデータの保存エラー:', err);
    }
}

// 期限切れファイルの自動クリーンアップ（安全なバックグラウンド処理）
function cleanupExpiredFiles() {
    try {
        const metadata = loadMetadata();
        const now = Date.now();
        let updated = false;

        for (const id in metadata) {
            // 万が一、短すぎる期限のデータがあれば7日後に直す
            const remainingTime = metadata[id].expiresAt - now;
            if (remainingTime > 0 && remainingTime < 60 * 60 * 1000) {
                metadata[id].expiresAt = now + EXPIRY_TIME_MS;
                updated = true;
            }

            if (metadata[id].expiresAt < now) {
                const filePath = path.join(UPLOAD_DIR, metadata[id].filename);
                if (fs.existsSync(filePath)) {
                    try {
                        fs.unlinkSync(filePath);
                    } catch (e) {}
                }
                delete metadata[id];
                updated = true;
            }
        }
        if (updated) {
            saveMetadata(metadata);
        }
    } catch (err) {
        console.error('クリーンアップエラー:', err);
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
    const originalName = req.headers['x-file-name'] ? decodeURIComponent(req.headers['x-file-name'] as string) : 'file.zip';
    const password = req.headers['x-file-password'] as string | undefined;

    if (!originalName.toLowerCase().endsWith('.zip')) {
        return res.status(400).json({ error: 'ZIPファイルでないファイルはZIPファイルおいてください' });
    }

    const fileId = uuidv4().substring(0, 8);
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
                try { fs.unlinkSync(filePath); } catch (e) {}
            }
            if (!res.headersSent) {
                res.status(400).json({ error: '３０0M以上のファイルは扱えませんとエラーが表示されます。' });
            }
        }
    });

    req.pipe(writeStream);

    writeStream.on('finish', () => {
        if (sizeExceeded) return;

        const metadata = loadMetadata();
        // 確実に今から7日後（604,800,000ミリ秒）に設定
        const expiresAt = Date.now() + EXPIRY_TIME_MS; 

        metadata[fileId] = {
            id: fileId,
            originalName,
            filename: savedFilename,
            size: fileSize,
            password: password ? password : undefined,
            expiresAt
        };

        saveMetadata(metadata);
        console.log(`[UPLOAD] 成功: ID=${fileId}, 期限=${new Date(expiresAt).toLocaleString()}`);

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
    const id = String(req.params.id);
    const { password } = req.body;
    const metadata = loadMetadata();

    const meta = metadata[id];
    if (!meta) {
        return res.status(404).json({ error: 'ファイルが見つからないか、期限切れです。' });
    }

    // 念のため期限切れチェック
    if (meta.expiresAt < Date.now()) {
        return res.status(404).json({ error: 'ファイルは期限切れです。' });
    }

    if (meta.password && meta.password !== password) {
        return res.status(401).json({ error: 'パスワードが違います。' });
    }

    res.json({ success: true, originalName: meta.originalName, size: meta.size });
});

// ダウンロード処理
app.get('/api/download/:id', (req: Request, res: Response) => {
    if (currentDownloads >= MAX_CONCURRENT_DOWNLOADS) {
        return res.status(503).json({ error: '少し経ってから再アクセスください。' });
    }

    const id = String(req.params.id);
    const password = req.query.pwd as string | undefined;
    const metadata = loadMetadata();
    const meta = metadata[id];

    if (!meta) {
        return res.status(404).json({ error: 'ファイルが存在しないか、期限切れです。' });
    }

    // 念のため期限切れチェック
    if (meta.expiresAt < Date.now()) {
        return res.status(404).json({ error: 'ファイルは期限切れです。' });
    }

    if (meta.password && meta.password !== password) {
        return res.status(401).json({ error: 'パスワード認証が必要です。' });
    }

    const filePath = path.join(UPLOAD_DIR, meta.filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: `ファイル本体が見つかりません` });
    }

    currentDownloads++;
    res.download(filePath, meta.originalName, (err) => {
        currentDownloads--;
    });
});

app.listen(PORT, () => {
    console.log(`えりのすとれーじ が起動しました: http://localhost:${PORT}`);
});