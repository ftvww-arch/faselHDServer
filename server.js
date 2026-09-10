const express = require('express');
const axios = require('axios');
const vm = require('vm');

const app = express();
const PORT = process.env.PORT || 3000;

// مسار استخراج الرابط (الذي استخدمناه سابقاً)
app.get('/api/extract', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'يرجى تمرير رابط url.' });

    try {
        const response = await axios.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                'Referer': 'https://www.fasel-hd.co/'
            }
        });

        const htmlContent = response.data;
        const scriptMatch = htmlContent.match(/(var video = document\.getElementById\('video'\);[\s\S]+?)<\/script>/);
        if (!scriptMatch) return res.status(404).json({ error: 'لم يتم العثور على السكريبت.' });

        const sandbox = {
            document: { getElementById: () => ({ canPlayType: () => false, src: '' }) },
            window: {},
            Hls: { isSupported: () => false },
            setInterval: () => {}, setTimeout: () => {},
            console: { log: () => {}, warn: () => {}, error: () => {} }
        };
        sandbox.window = sandbox;
        sandbox.global = sandbox;

        vm.createContext(sandbox);
        vm.runInContext(scriptMatch[1], sandbox);

        if (sandbox.videoSrc) {
            return res.json({
                success: true,
                stream_url: sandbox.videoSrc,
                // مسار المشغل الجديد على سيرفرك
                proxy_player_url: `${req.protocol}://${req.get('host')}/api/play?url=${encodeURIComponent(sandbox.videoSrc)}`
            });
        } else {
            return res.status(500).json({ error: 'فشل في استخراج رابط الفيديو.' });
        }
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

// المسار الجديد: يعمل كـ Proxy لنقل البث مباشرة لجهازك دون مشاكل IP
app.get('/api/play', async (req, res) => {
    const streamUrl = req.query.url;
    if (!streamUrl) return res.status(400).send('Missing stream url');

    try {
        // السيرفر يطلب ملفات البث (m3u8 أو أجزاء الفيديو .ts) بالنيابة عنك
        const response = await axios({
            method: 'get',
            url: streamUrl,
            responseType: 'stream', // مهم جداً لنقل دفق البيانات (Stream)
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                'Referer': 'https://www.fasel-hd.co/',
                'Origin': 'https://www.fasel-hd.co'
            }
        });

        // نسخ الترويسات العائدة من السيرفر الأصلي (مثل نوع المحتوى hls أو video/mp2t)
        res.setHeader('Content-Type', response.headers['content-type'] || 'application/vnd.apple.mpegurl');
        
        // تمرير البيانات مباشرة إلى المستخدم
        response.data.pipe(res);

    } catch (error) {
        res.status(500).send('Stream proxy error: ' + error.message);
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
