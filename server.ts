import express, { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';

const app = express();
const PORT = 3000;

const isProduction = process.env.NODE_ENV === 'production';
const UPLOAD_DIR = isProduction ? '/data/uploads' : path.join(__dirname, 'uploads');
const METADATA_FILE = isProduction ? '/data/metadata.json' : path.join(__dirname, 'metadata.json');

const MAX_FILE_SIZE = 300 * 1024 * 1024; 
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

// 初期化とディレクトリ確認
console.log(`[VERIFY] 環境: ${isProduction ? 'Production (Fly.io /data)' : 'Local'}`);
console.log(`[VERIFY] UPLOAD_DIR: ${UPLOAD_DIR}`);
console.log(`[VERIFY] METADATA_FILE: ${METADATA_FILE}`);

try {
    if (!fs.existsSync(UPLOAD_DIR)) {
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        console.log(`[VERIFY] アップロードディレクトリを新規作成しました。`);
    } else {
        console.log(`[VERIFY] アップロードディレクトリは既に存在します。中のファイル数: ${fs.readdirSync(UPLOAD_DIR).length}`);
    }
} catch (e) {
    console.error(`[ERROR] UPLOAD_DIR 初期化失敗:`, e);
}

try {
    if (!fs.existsSync(METADATA_FILE)) {
        fs.writeFileSync(METADATA_FILE, JSON.stringify({}, null, 2));
        console.log(`[VERIFY] メタデータファイルを新規作成しました。`);
    } else {
        const content = fs.readFileSync(METADATA_FILE, 'utf-8');
        console.log(`[VERIFY] メタデータファイルが存在します。内容: ${content}`);
    }
} catch (e) {
    console.error(`[ERROR] METADATA_FILE 初期化失敗:`, e);
}

function loadMetadata(): Record<string, FileMeta> {
    try {
        if (fs.existsSync(METADATA_FILE)) {
            const data = fs.readFileSync(METADATA_FILE, 'utf-8');
            const parsed = data ? JSON.parse(data) : {};
            console.log(`[DEBUG] メタデータ読み込み成功。登録ファイル数: ${Object.keys(parsed).length}`);
            return parsed;
        }
        return {};
    } catch (err) {
        console.error('[ERROR] メタデータの読み込み失敗:', err);
        return {};
    }
}

function saveMetadata(data: Record<string, FileMeta>) {
    try {
        fs.writeFileSync(METADATA_FILE, JSON.stringify(data, null, 2));
        console.log(`[DEBUG] メタデータ保存成功。登録ファイル数: ${Object.keys(data).length}`);
    } catch (err) {
        console.error('[ERROR] メタデータの保存失敗:', err);
    }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/dl/:id', (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'dl.html'));
});

// アップロード
app.post('/api/upload', (req: Request, res: Response) => {
    const originalName = req.headers['x-file-name'] ? decodeURIComponent(req.headers['x-file-name'] as string) : 'file.zip';
    const password = req.headers['x-file-password'] as string | undefined;

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
                res.status(400).json({ error: '300MB超えてます' });
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
        console.log(`[UPLOAD] 完了: ID=${fileId}, パス=${filePath}, 保存時刻=${new Date(now).toISOString()}, 有効期限=${new Date(expiresAt).toISOString()}`);

        res.json({ success: true, downloadUrl: `/dl/${fileId}` });
    });

    writeStream.on('error', (err) => {
        console.error('[ERROR] アップロード書き込みエラー:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: '失敗しました' });
        }
    });
});

// チェック
app.post('/api/check/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const { password } = req.body;
    const metadata = loadMetadata();

    console.log(`[CHECK] 要求ID: ${id}, 現在のメタデータキー一覧: ${Object.keys(metadata).join(', ')}`);

    const meta = metadata[id];
    if (!meta) {
        console.log(`[CHECK] ❌ IDが見つかりません: ${id}`);
        return res.status(404).json({ error: 'ファイルが見つからないか、期限切れです。' });
    }

    const now = Date.now();
    console.log(`[CHECK] ℹ️ ファイル発見: ID=${id}, 経過時間=${Math.floor((now - meta.createdAt) / 1000)}秒, 残り時間=${Math.floor((meta.expiresAt - now) / 1000)}秒`);

    if (meta.expiresAt < now) {
        console.log(`[CHECK] ❌ 期限切れ判定されています (現在: ${now} > 期限: ${meta.expiresAt})`);
        return res.status(404).json({ error: 'ファイルは期限切れです。' });
    }

    if (meta.password && meta.password !== password) {
        return res.status(401).json({ error: 'パスワードが違います。' });
    }

    res.json({ success: true, originalName: meta.originalName, size: meta.size });
});

// ダウンロード
app.get('/api/download/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const password = req.query.pwd as string | undefined;
    const metadata = loadMetadata();
    const meta = metadata[id];

    if (!meta || meta.expiresAt < Date.now()) {
        return res.status(404).json({ error: 'ファイルが存在しないか、期限切れです。' });
    }

    const filePath = path.join(UPLOAD_DIR, meta.filename);
    if (!fs.existsSync(filePath)) {
        console.log(`[ERROR] メタデータには存在するが、実ファイルが見つかりません: ${filePath}`);
        return res.status(404).json({ error: 'ファイル本体が見つかりません。' });
    }

    res.download(filePath, meta.originalName);
});

app.listen(PORT, () => {
    console.log(`検証用サーバー起動: http://localhost:${PORT}`);
});