const express = require('express');
const axios = require('axios');
const vm = require('vm');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. مسار الاستخراج (كما هو في كودك الأصلي)
app.get('/api/extract', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) return res.status(400).json({ error: 'يرجى تمرير رابط url صالح في الطلب.' });

    try {
        const response = await axios.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                'Referer': 'https://www.fasel-hd.co/'
            }
        });

        const scriptMatch = response.data.match(/(var video = document\.getElementById\('video'\);[\s\S]+?)<\/script>/);
        if (!scriptMatch) return res.status(404).json({ error: 'لم يتم العثور على سكريبت المشغل المشفر.' });

        const scriptCode = scriptMatch[1];
        const sandbox = {
            document: { getElementById: () => ({ canPlayType: () => false, src: '' }) },
            window: {},
            Hls: { isSupported: () => false },
            setInterval: () => {}, setTimeout: () => {}, console: { log: () => {}, warn: () => {}, error: () => {} }
        };
        sandbox.window = sandbox; sandbox.global = sandbox;
        vm.createContext(sandbox); vm.runInContext(scriptCode, sandbox);

        if (sandbox.videoSrc) {
            // بدلاً من إعطاء الرابط المباشر للمستخدم، نعطيه رابط البروكسي الخاص بنا
            const proxyUrl = `${req.protocol}://${req.get('host')}/api/proxy?url=${encodeURIComponent(sandbox.videoSrc)}`;

            return res.json({
                success: true,
                stream_url_direct: sandbox.videoSrc, // الرابط الأصلي (مربوط بـ IP السيرفر)
                proxy_url: proxyUrl // هذا الرابط الذي ستضعه في مشغل الفيديو
            });
        } else {
            return res.status(500).json({ error: 'لم يتم العثور على الرابط.' });
        }
    } catch (error) {
        return res.status(500).json({ error: 'حدث خطأ', details: error.message });
    }
});

// 2. مسار البروكسي (يقوم بسحب الفيديو من السيرفر وبثه للمستخدم)
app.get('/api/proxy', async (req, res) => {
    const streamUrl = req.query.url;

    if (!streamUrl) {
        return res.status(400).send('URL is required');
    }

    // إعداد الهيدرز التي سنرسلها لسيرفر الفيديو
    const requestHeaders = {
        "Origin": "https://www.fasel-hd.co",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Referer": "https://www.fasel-hd.co/"
    };

    // دعم التقديم والتأخير (Seeking): إذا طلب المشغل جزء معين من الفيديو، نمرر الطلب
    if (req.headers.range) {
        requestHeaders['Range'] = req.headers.range;
    }

    try {
        const response = await axios({
            method: 'get',
            url: streamUrl,
            responseType: 'stream',
            headers: requestHeaders,
            // السماح باستقبال الحالات 200 (محتوى كامل) و 206 (محتوى مجزأ للتقديم والتأخير)
            validateStatus: (status) => (status >= 200 && status < 300) 
        });

        // تمرير الهيدرز المهمة من سيرفر الفيديو إلى متصفح المستخدم
        const headersToForward = ['content-type', 'content-length', 'accept-ranges', 'content-range'];
        headersToForward.forEach(header => {
            if (response.headers[header]) {
                res.setHeader(header, response.headers[header]);
            }
        });

        // تمرير كود الحالة (مثلاً 206 Partial Content لو كان هناك Range)
        res.status(response.status);

        // ربط تدفق البيانات (Piping) مباشرة إلى المستخدم
        response.data.pipe(res);

    } catch (error) {
        console.error('Proxy Error:', error.message);
        if (!res.headersSent) {
            res.status(500).send('Error proxying the stream');
        }
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
