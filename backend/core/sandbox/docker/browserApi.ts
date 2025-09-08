import express from 'express';
import { Stagehand, type LogLine, type Page } from '@browserbasehq/stagehand';
import { FileChooser } from 'playwright';

const app = express();
app.use(express.json());

interface BrowserActionResult {
    success: boolean;
    message: string;
    error?: string;
    url: string;
    title: string;
    screenshot_base64?: string;
    action?: string;
}

class BrowserAutomation {
    public router: express.Router;

    private stagehand: Stagehand | null;
    public browserInitialized: boolean;
    private page: Page | null;
    constructor() {
        this.router = express.Router();
        this.browserInitialized = false;
        this.stagehand = null;
        this.page = null;

        this.router.post('/navigate', this.navigate.bind(this));
        this.router.post('/screenshot', this.screenshot.bind(this));
        this.router.post('/act', this.act.bind(this));
        this.router.post('/extract', this.extract.bind(this));

    }

    async init(apiKey: string): Promise<{status: string, message: string}> {
        try{
            if (!this.browserInitialized) {
                console.log("Initializing browser with api key");
                this.stagehand = new Stagehand({
                    env: "LOCAL",
                    enableCaching: true,
                    verbose: 2,
                    logger: (logLine: LogLine) => {
                        console.log(`[${logLine.category}] ${logLine.message}`);
                    },
                    modelName: "google/gemini-2.5-pro",
                    modelClientOptions: {
                        apiKey
                    },
                    localBrowserLaunchOptions: {
                        headless: false,
                        viewport: {
                            width: 1024,
                            height: 768
                        },
                        downloadsPath: '/workspace/downloads',
                        acceptDownloads: true,
                        preserveUserDataDir: true,
                        args: [
                            "--remote-debugging-port=9222",
                            "--no-sandbox",
                            "--disable-setuid-sandbox",
                            "--disable-dev-shm-usage",
                            "--disable-gpu"
                        ]
                    }
                });
                await this.stagehand.init();
                this.browserInitialized = true;
                this.page = this.stagehand.page;

                // Attach listeners to detect browser or page crashes and reset state accordingly
                if (this.page) {
                    // If the browser page itself closes we mark the automation as un-initialised
                    this.page.on('close', () => {
                        console.log('Browser page closed - resetting state');
                        this.browserInitialized = false;
                    });

                    // If the underlying browser disconnects (e.g. crashes) we also reset state
                    try {
                        const browserInstance = this.page.context().browser();
                        browserInstance?.on('disconnected', () => {
                            console.log('Browser disconnected - resetting state');
                            this.browserInitialized = false;
                        });
                    } catch (err) {
                        console.error('Failed to attach browser disconnect handler', err);
                    }
                }

                await this.page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
                return {
                    status: "initialized",
                    message: "Browser initialized"
                }
            }
            return {
                status: "healthy",
                message: "Browser already initialized"
            }
        } catch (error) {
            console.error("Error initializing browser", error);
            return {
                status: "error",
                message: "Failed to initialize browser"
            }
        }
    }

    health(): {status: string} {
        if (this.browserInitialized && this.page && !this.page.isClosed()) {
            return {
                status: "healthy"
            }
        }
        return {
            status: "unhealthy"
        }
    }

    async shutdown() {
        console.log("Shutting down browser");
        this.browserInitialized = false;
        this.stagehand?.close();
        this.stagehand = null;
        this.page = null;
        return {
            status: "shutdown",
            message: "Browser shutdown"
        }
    }

    async get_stagehand_state() {
        try{
            const health = this.health();
            if (this.page && health.status === "healthy") {
                const screenshot_base64 = await this.page.screenshot({ fullPage: false }).then(buffer => buffer.toString('base64'));
                const page_info = {
                    url: await this.page.url(),
                    title: await this.page.title(),
                    screenshot_base64: screenshot_base64,
                };
                return page_info;
            }
            return {
                url: "",
                title: "",
                screenshot_base64: "",
            }
        } catch (error) {
            console.error("Error capturing stagehand state", error);
            return {
                url: "",
                title: "",
                screenshot_base64: "",
            }
        }
    }

    async navigate(req: express.Request, res: express.Response): Promise<void> {
        try {
            if (this.page && this.browserInitialized) {
                const { url } = req.body;
                await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                const page_info = await this.get_stagehand_state();
                const result: BrowserActionResult = {
                    success: true,
                    message: "Navigated to " + url,
                    error: "",
                    url: page_info.url,
                    title: page_info.title,
                    screenshot_base64: page_info?.screenshot_base64,
                }
                res.json(result);
            } else {
                res.status(500).json({
                    "status": "error",
                    "message": "Browser not initialized"
                })

            }
        } catch (error) {
            console.error(error);
            const page_info = await this.get_stagehand_state();
            res.status(500).json({
                success: false,
                message: "Failed to navigate to " + req.body.url,
                url: page_info.url,
                title: page_info.title,
                screenshot_base64: page_info.screenshot_base64,
                error
            })
        }
    }

    async screenshot(req: express.Request, res: express.Response): Promise<void> {
        try {
            if (this.page && this.browserInitialized) {
                const page_info = await this.get_stagehand_state();
                const result: BrowserActionResult = {
                    success: true,
                    message: "Screenshot taken",
                    url: page_info.url,
                    title: page_info.title,
                    screenshot_base64: page_info.screenshot_base64,
                }
                res.json(result);
            } else {
                res.status(500).json({
                    "status": "error",
                    "message": "Browser not initialized"
                })
            }
        } catch (error) {
            console.error(error);
            res.status(500).json({
                success: false,
                message: "Failed to take screenshot",
                error
            })
        }
    }

    async act(req: express.Request, res: express.Response): Promise<void> {
        let fileChooseHandler: ((fileChooser: FileChooser) => Promise<void>) | null = null;
        try {
            if (this.page && this.browserInitialized) {
                const { action, iframes, variables, filePath } = req.body;

                const fileChooseHandler = async (fileChooser: FileChooser) => {
                    if(filePath){
                        await fileChooser.setFiles(filePath);
                    } else {
                        await fileChooser.setFiles([]);
                    }
                };

                this.page.on('filechooser', fileChooseHandler);

                const result = await this.page.act({action, iframes: iframes || true, variables});
                const page_info = await this.get_stagehand_state();
                const response: BrowserActionResult = {
                    success: result.success,
                    message: result.message,
                    action: result.action,
                    url: page_info.url,
                    title: page_info.title,
                    screenshot_base64: page_info.screenshot_base64,
                }
                res.json(response);
            } else {
                res.status(500).json({
                    "status": "error",
                    "message": "Browser not initialized"
                })
            }
        } catch (error) {
            console.error(error);
            const page_info = await this.get_stagehand_state();
            res.status(500).json({
                success: false,
                message: "Failed to act",
                url: page_info.url,
                title: page_info.title,
                screenshot_base64: page_info.screenshot_base64,
                error
            })
        } finally {
            if (this.page && fileChooseHandler) {
                this.page.off('filechooser', fileChooseHandler);
            }
        }

    }

    async extract(req: express.Request, res: express.Response): Promise<void> {
        try {
            if (this.page && this.browserInitialized) {
                const { instruction, iframes } = req.body;
                const result = await this.page.extract({ instruction, iframes });
                const page_info = await this.get_stagehand_state();
                const response: BrowserActionResult = {
                    success: result.success,
                    message: `Extracted result for: ${instruction}`,
                    action: result.extraction,
                    url: page_info.url,
                    title: page_info.title,
                    screenshot_base64: page_info.screenshot_base64,
                }
                res.json(response);
            }
        } catch (error) {
            console.error(error);
            const page_info = await this.get_stagehand_state();
            res.status(500).json({
                success: false,
                message: "Failed to extract",
                url: page_info.url,
                title: page_info.title,
                screenshot_base64: page_info.screenshot_base64,
                error
            })
        }
    }

}

const browserAutomation = new BrowserAutomation();

app.use('/api', browserAutomation.router);

app.get('/api', (req, res) => {
    console.log("Health check");
    const health = browserAutomation.health();
    if (health.status === "healthy") {
        res.status(200).json({
            "status": "healthy",
            "service": "browserApi"
        })
    } else {
        res.status(500).json({
            "status": "unhealthy",
            "service": "browserApi"
        })
    }
});

app.post('/api/init', async (req, res) => {
    console.log("Initializing browser");
    const {api_key} = req.body;
    const result = await browserAutomation.init(api_key);
    
    if (result.status === "initialized") {
        res.status(200).json({
            "status": "healthy",
            "service": "browserApi"
        })
    } else {
        res.status(500).json({
            "status": "error",
            "message": result.message
        })
    }
});

app.listen(8004, () => {
    console.log('Starting browser server on port 8004');
});