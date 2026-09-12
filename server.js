const express = require('express');
const axios = require('axios');
const vm = require('vm');

const app = express();
const PORT = process.env.PORT || 3000;

// الهيدرز الأساسية التي تخدع الموقع وتوهمه أن الطلب من متصفح شرعي
const DEFAULT_HEADERS = {
    "Origin": "https://www.fasel-hd.co",
    "Referer": "https://www.fasel-hd.co/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
};

// 1. مسار الاستخراج
app.get('/api/extract', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) return res.status(400).json({ error: 'يرجى تمرير رابط url صالح.' });

    try {
        const response = await axios.get(targetUrl, { headers: DEFAULT_HEADERS });

        const scriptMatch = response.data.match(/(var video = document\.getElementById\('video'\);[\s\S]+?)<\/script>/);
        if (!scriptMatch) return res.status(404).json({ error: 'لم يتم العثور على سكريبت المشغل.' });

        const scriptCode = scriptMatch[1];
        const sandbox = {
            document: { getElementById: () => ({ canPlayType: () => false, src: '' }) },
            window: {}, Hls: { isSupported: () => false },
            setInterval: () => {}, setTimeout: () => {}, console: { log: () => {}, warn: () => {}, error: () => {} }
        };
        sandbox.window = sandbox; sandbox.global = sandbox;
        vm.createContext(sandbox); vm.runInContext(scriptCode, sandbox);

        if (sandbox.videoSrc) {
            // توليد رابط البروكسي الخاص بنا
            const proxyUrl = `${req.protocol}://${req.get('host')}/api/proxy?url=${encodeURIComponent(sandbox.videoSrc)}`;
            return res.json({
                success: true,
                stream_url_direct: sandbox.videoSrc, 
                proxy_url: proxyUrl 
            });
        } else {
            return res.status(500).json({ error: 'لم يتم العثور على الرابط.' });
        }
    } catch (error) {
        return res.status(500).json({ error: 'حدث خطأ', details: error.message });
    }
});

// 2. مسار البروكسي الذكي (يعالج الـ M3U8 والـ TS)
app.get('/api/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('URL is required');

    // السماح للمتصفح ومقاطع الفيديو بالعمل بدون مشاكل CORS
    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
        // التحقق مما إذا كان الرابط هو لملف M3U8
        const isM3u8 = targetUrl.includes('.m3u8');

        if (isM3u8) {
            // جلب ملف الـ M3U8 كنص
            const response = await axios.get(targetUrl, { headers: DEFAULT_HEADERS });
            let content = response.data;

            const baseUrl = new URL(targetUrl);
            const lines = content.split('\n');

            // تعديل الروابط داخل الملف
            const modifiedLines = lines.map(line => {
                line = line.trim();
                if (!line) return line;

                // معالجة روابط مفاتيح التشفير إن وجدت
                if (line.startsWith('#EXT-X-KEY') && line.includes('URI="')) {
                    return line.replace(/URI="([^"]+)"/, (match, uri) => {
                        const absoluteUri = new URL(uri, baseUrl.href).href;
                        const proxyUri = `${req.protocol}://${req.get('host')}/api/proxy?url=${encodeURIComponent(absoluteUri)}`;
                        return `URI="${proxyUri}"`;
                    });
                }

                // ترك السطور التي تبدأ بـ # (إعدادات المشغل) كما هي
                if (line.startsWith('#')) return line;

                // السطر عبارة عن رابط لملف فيديو (.ts) أو قائمة جودات أخرى
                // نحوله إلى رابط كامل أولاً
                const absoluteUrlObj = new URL(line, baseUrl.href);

                // بعض السيرفرات تحتاج التوكن (Query Parameters) الموجود في الرابط الأصلي، نمرره هنا
                baseUrl.searchParams.forEach((value, key) => {
                    if (!absoluteUrlObj.searchParams.has(key)) {
                        absoluteUrlObj.searchParams.set(key, value);
                    }
                });

                // توجيه الرابط ليمر عبر البروكسي الخاص بنا
                return `${req.protocol}://${req.get('host')}/api/proxy?url=${encodeURIComponent(absoluteUrlObj.href)}`;
            });

            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            return res.send(modifiedLines.join('\n'));

        } else {
            // إذا كان الرابط عبارة عن ملف فيديو (TS / MP4)، نقوم بعمل بث (Stream) مباشر
            const headers = { ...DEFAULT_HEADERS };
            if (req.headers.range) headers['Range'] = req.headers.range;

            const response = await axios({
                method: 'get',
                url: targetUrl,
                responseType: 'stream',
                headers: headers,
                validateStatus: status => status >= 200 && status < 300 
            });

            // تمرير الهيدرز المهمة لمشغل الفيديو
            ['content-type', 'content-length', 'accept-ranges', 'content-range'].forEach(h => {
                if (response.headers[h]) res.setHeader(h, response.headers[h]);
            });

            res.status(response.status);
            response.data.pipe(res);
        }

    } catch (error) {
        console.error("Proxy Error:", error.message);
        if (!res.headersSent) res.status(500).send('Error proxying media');
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
