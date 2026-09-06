import express, { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';

const app = express();
const PORT = 3000;

const isFlyEnv = fs.existsSync('/data') || process.env.NODE_ENV === 'production';
const UPLOAD_DIR = isFlyEnv ? '/data/uploads' : path.join(__dirname, 'uploads');
const METADATA_FILE = isFlyEnv ? path.join('/data', 'metadata.json') : path.join(__dirname, 'metadata.json');

// 授業用：最大ファイルサイズを 10MB に設定
const MAX_FILE_SIZE = 10 * 1024 * 1024; 
const EXPIRY_TIME_MS = 7 * 24 * 60 * 60 * 1000; // 7日

interface FileMeta {
    id: string;
    originalName: string;
    filename: string;
    size: number;
    password?: string;
    createdAt: number;
    expiresAt: number;
}

// ディレクトリ作成
try {
    if (!fs.existsSync(UPLOAD_DIR)) {
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }
} catch (e) {
    console.error('UPLOAD_DIR作成失敗:', e);
}

if (!fs.existsSync(METADATA_FILE)) {
    try {
        fs.writeFileSync(METADATA_FILE, JSON.stringify({}, null, 2));
    } catch (e) {}
}

// 常にディスクから最新のメタデータを確実に読み込む
function loadMetadata(): Record<string, FileMeta> {
    try {
        if (fs.existsSync(METADATA_FILE)) {
            const data = fs.readFileSync(METADATA_FILE, 'utf-8');
            return data ? JSON.parse(data) : {};
        }
        return {};
    } catch (err) {
        console.error('メタデータ読み込みエラー:', err);
        return {};
    }
}

// メタデータの保存
function saveMetadata(data: Record<string, FileMeta>) {
    try {
        fs.writeFileSync(METADATA_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('メタデータ保存エラー:', err);
    }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/dl/:id', (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'dl.html'));
});

// アップロード処理（10MB制限）
app.post('/api/upload', (req: Request, res: Response) => {
    const originalName = req.headers['x-file-name'] ? decodeURIComponent(req.headers['x-file-name'] as string) : 'file.zip';
    const password = req.headers['x-file-password'] as string | undefined;

    if (!originalName.toLowerCase().endsWith('.zip')) {
        return res.status(400).json({ error: 'ZIPファイルのみアップロード可能です。' });
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
            if (fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch(e){} }
            if (!res.headersSent) {
                res.status(400).json({ error: '10MBを超えるファイルはアップロードできません。' });
            }
        }
    });

    req.pipe(writeStream);

    writeStream.on('finish', () => {
        if (sizeExceeded) return;

        const metadata = loadMetadata();
        const now = Date.now();
        const expiresAt = now + EXPIRY_TIME_MS;

        metadata[fileId] = {
            id: fileId,
            originalName,
            filename: savedFilename,
            size: fileSize,
            password: password ? password : undefined,
            createdAt: now,
            expiresAt
        };

        saveMetadata(metadata);
        console.log(`[UPLOAD] 成功: ID=${fileId}, サイズ=${Math.round(fileSize / 1024)}KB`);

        res.json({ success: true, downloadUrl: `/dl/${fileId}` });
    });

    writeStream.on('error', (err) => {
        if (!res.headersSent) {
            res.status(500).json({ error: '失敗しました' });
        }
    });
});

// ファイル確認用API
app.post('/api/check/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const { password } = req.body;
    const metadata = loadMetadata();

    const meta = metadata[id];
    if (!meta) {
        return res.status(404).json({ error: 'ファイルが見つからないか、期限切れです。' });
    }

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
    const id = String(req.params.id);
    const password = req.query.pwd as string | undefined;
    const metadata = loadMetadata();
    const meta = metadata[id];

    if (!meta || meta.expiresAt < Date.now()) {
        return res.status(404).json({ error: 'ファイルが存在しないか、期限切れです。' });
    }

    if (meta.password && meta.password !== password) {
        return res.status(401).json({ error: 'パスワード認証が必要です。' });
    }

    const filePath = path.join(UPLOAD_DIR, meta.filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'ファイル本体が見つかりません。' });
    }

    res.download(filePath, meta.originalName);
});

app.listen(PORT, () => {
    console.log(`サーバー起動: http://localhost:${PORT}`);
});