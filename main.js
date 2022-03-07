"use strict";

/*
 * Created with @iobroker/create-adapter v1.34.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const rax = require("retry-axios");
const axios = require("axios");
const crypto = require("crypto");
const qs = require("qs");
const { extractKeys } = require("./lib/extractKeys");

class Viessmannapi extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: "viessmannapi",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
        this.installationArray = [];
        this.userAgent = "ioBroker 2.0.4";
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Reset the connection indicator during startup
        this.setState("info.connection", false, true);
        if (this.config.interval < 0.5) {
            this.log.info("Set interval to minimum 0.5");
            this.config.interval = 0.5;
        }
        if (this.config.eventInterval < 0.5) {
            this.log.info("Set interval to minimum 0.5");
            this.config.eventInterval = 0.5;
        }
        this.requestClient = axios.create();
        this.requestClient.defaults.raxConfig = {
            instance: this.requestClient,
            statusCodesToRetry: [[500, 599]],
            httpMethodsToRetry: ["POST"],
        };
        const interceptorId = rax.attach(this.requestClient);

        this.updateInterval = null;
        this.eventInterval = null;
        this.reLoginTimeout = null;
        this.refreshTokenTimeout = null;
        this.extractKeys = extractKeys;
        this.idArray = [];
        this.session = {};
        this.rangeMapSupport = {};

        this.subscribeStates("*");

        await this.login();
        if (this.session.access_token) {
            await this.getDeviceIds();
            await this.updateDevices(true);
            await this.getEvents();
            this.updateInterval = setInterval(async () => {
                await this.updateDevices();
            }, this.config.interval * 60 * 1000);

            this.eventInterval = setInterval(async () => {
                await this.getEvents();
            }, this.config.eventInterval * 60 * 1000);

            this.refreshTokenInterval = setInterval(() => {
                this.refreshToken();
            }, (this.session.expires_in - 100) * 1000);
        }
    }
    async login() {
        const [code_verifier, codeChallenge] = this.getCodeChallenge();
        const headers = {
            Accept: "*/*",
            "User-Agent": this.userAgent,
        };
        let data = {
            client_id: this.config.client_id,
            response_type: "code",
            scope: "IoT User offline_access",
            code_challenge_method: "S256",
            code_challenge: codeChallenge,
            redirect_uri: "http://localhost:4200/",
        };

        const htmlLoginForm = await this.requestClient({
            method: "get",
            url: "https://iam.viessmann.com/idp/v2/authorize",
            headers: headers,
            params: data,
        })
            .then((res) => {
                this.log.debug(JSON.stringify(res.data));
                return res.data;
            })
            .catch((error) => {
                this.log.error(error);
                if (error.response) {
                    this.log.error(JSON.stringify(error.response.data));
                }
            });
        if (!htmlLoginForm) {
            return;
        }
        let url = htmlLoginForm.split('action="')[1].split('" auto')[0];
        url = url.replace(/&amp;/g, "&");
        data = {
            isiwebuserid: this.config.username,
            "hidden-password": "00",
            isiwebpasswd: this.config.password,
            stayloggedin: "Stay+logged+on",
            submit: "LOGIN",
        };
        const code = await this.requestClient({
            method: "post",
            url: url,
            headers: headers,
            data: qs.stringify(data),
        })
            .then((res) => {
                this.log.debug(JSON.stringify(res.data));
                this.log.error("Please check username/password and deactivated Google Captcha in the Viessmann Settings");
                return res.data;
            })
            .catch((error) => {
                let code = "";
                if (error.response && error.response.status === 400) {
                    this.log.error(JSON.stringify(error.response.data));
                    return;
                }
                if (error.response && error.response.status === 500) {
                    this.log.info("Please check username and password.");
                    return;
                }
                if (error.request) {
                    this.log.debug(JSON.stringify(error.request._currentUrl));
                    if (!error.request._currentUrl) {
                        this.log.error(JSON.stringify(error));
                        return;
                    }
                    code = qs.parse(error.request._currentUrl.split("?")[1]).code;
                    this.log.debug(code);
                    return code;
                }
            });
        data = {
            grant_type: "authorization_code",
            code: code,
            client_id: this.config.client_id,
            code_verifier: code_verifier,
            redirect_uri: "http://localhost:4200/",
        };

        await this.requestClient({
            method: "post",
            url: "https://iam.viessmann.com/idp/v2/token",
            headers: headers,
            data: qs.stringify(data),
        })
            .then((res) => {
                this.log.debug(JSON.stringify(res.data));
                this.session = res.data;
                this.setState("info.connection", true, true);
                return res.data;
            })
            .catch((error) => {
                this.setState("info.connection", false, true);
                this.log.error(error);
                if (error.response && error.response.status === 429) {
                    this.log.info("Rate limit reached. Will be reseted next day 02:00");
                }
                if (error.response) {
                    this.log.error(JSON.stringify(error.response.data));
                }
            });
    }
    async getDeviceIds() {
        const headers = {
            "Content-Type": "application/json",
            Accept: "*/*",
            "User-Agent": this.userAgent,
            Authorization: "Bearer " + this.session.access_token,
        };

        await this.requestClient({
            method: "get",
            url: "https://api.viessmann.com/iot/v1/equipment/installations?includeGateways=true",
            headers: headers,
        })
            .then(async (res) => {
                this.log.debug(JSON.stringify(res.data));
                if (res.data.data && res.data.data.length > 0) {
                    this.installationArray = res.data.data;
                    this.log.info(this.installationArray.length + " installations found.");
                    for (const installation of this.installationArray) {
                        const installationId = installation.id.toString();
                        await this.setObjectNotExistsAsync(installationId, {
                            type: "device",
                            common: {
                                name: installation.description,
                            },
                            native: {},
                        });
                        this.extractKeys(this, installationId, installation, null, true);
                    }
                } else {
                    this.log.info("No installation found");
                }
            })
            .catch((error) => {
                this.log.error(error);
                if (error.response && error.response.status === 429) {
                    this.log.info("Rate limit reached. Will be reseted next day 02:00");
                }
                error.response && this.log.error(JSON.stringify(error.response.data));
            });
        for (const installation of this.installationArray) {
            const installationId = installation.id.toString();
            if (installation.gateways.length > 1) {
                this.log.info("Found " + installation.gateways.length + " gateways for installation ");
                this.log.info("Filter out offline gateways.");
                installation.gateways = installation.gateways.filter((gateway) => {
                    return gateway.aggregatedStatus !== "Offline";
                });
                this.log.info("Found " + installation.gateways.length + " online gateways select first gateway.");
            }
            for (const device of installation.gateways[0].devices) {
                await this.setObjectNotExistsAsync(installationId + "." + device.id, {
                    type: "device",
                    common: {
                        name: device.modelId,
                    },
                    native: {},
                });

                await this.setObjectNotExistsAsync(installationId + "." + device.id + ".general", {
                    type: "channel",
                    common: {
                        name: "General Device Information",
                    },
                    native: {},
                });

                this.extractKeys(this, installationId + "." + device.id + ".general", device);
            }
        }
    }
    async updateDevices(ignoreFilter) {
        const statusArray = [
            {
                path: "features",
                url: "https://api.viessmann.com/iot/v1/equipment/installations/$installation/gateways/$gateway/devices/$id/features",
                desc: "Features and States of the device",
            },
        ];

        const headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            "User-Agent": this.userAgent,
            Authorization: "Bearer " + this.session.access_token,
        };
        this.installationArray.forEach((installation) => {
            if (!installation["gateways"][0]) {
                return;
            }
            installation["gateways"][0]["devices"].forEach((device) => {
                statusArray.forEach(async (element) => {
                    let url = element.url.replace("$id", device.id);
                    url = url.replace("$installation", installation.id);
                    url = url.replace("$gateway", device.gatewaySerial);
                    if (!ignoreFilter && (device.roles.includes("type:gateway") || device.roles.includes("type:virtual"))) {
                        this.log.debug("ignore " + device.type);
                        return;
                    }
                    await this.requestClient({
                        method: "get",
                        url: url,
                        headers: headers,
                    })
                        .then((res) => {
                            this.log.debug(url + " " + device.id + " " + JSON.stringify(res.data));
                            if (!res.data) {
                                return;
                            }
                            let data = res.data;
                            const keys = Object.keys(res.data);
                            if (keys.length === 1) {
                                data = res.data[keys[0]];
                            }
                            if (data.length === 1) {
                                data = data[0];
                            }
                            const extractPath = installation.id + "." + device.id + "." + element.path;
                            const forceIndex = null;

                            this.extractKeys(this, extractPath, data, "feature", forceIndex, false, element.desc);
                        })
                        .catch((error) => {
                            if (error.response && error.response.status === 401) {
                                error.response && this.log.debug(JSON.stringify(error.response.data));
                                this.log.info(element.path + " receive 401 error. Refresh Token in 30 seconds");
                                clearTimeout(this.refreshTokenTimeout);
                                this.refreshTokenTimeout = setTimeout(() => {
                                    this.refreshToken();
                                }, 1000 * 30);

                                return;
                            }
                            if (error.response && error.response.status === 429) {
                                this.log.info("Rate limit reached. Will be reseted next day 02:00");
                            }
                            if (error.response && error.response.status === 500) {
                                this.log.info("Error 500. ViessmanAPI not available because of unstable server. Please contact Viessmann and ask them to improve their server");
                                return;
                            }
                            if (error.response && error.response.status === 502) {
                                this.log.info("Please check the connection of your gateway");
                            }
                            if (error.response && error.response.status === 504) {
                                this.log.info("Viessmann API is not available please try again later");
                            }
                            this.log.error(element.url);
                            this.log.error(error);
                            error.response && this.log.error(JSON.stringify(error.response.data));
                        });
                });
            });
        });
    }
    async getEvents() {
        const headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            "User-Agent": this.userAgent,
            Authorization: "Bearer " + this.session.access_token,
        };
        for (const installation of this.installationArray) {
            const installationId = installation.id.toString();
            if (!installation["gateways"][0]) {
                return;
            }
            const gatewaySerial = installation["gateways"][0].serial.toString();
            await this.requestClient({
                method: "get",
                url: "https://api.viessmann.com/iot/v1/events-history/events?gatewaySerial=" + gatewaySerial + "&installationId=" + installationId,
                headers: headers,
            })
                .then((res) => {
                    this.log.debug(JSON.stringify(res.data));
                    if (!res.data) {
                        return;
                    }
                    let data = res.data;
                    const keys = Object.keys(res.data);
                    if (keys.length === 1) {
                        data = res.data[keys[0]];
                    }
                    if (data.length === 1) {
                        data = data[0];
                    }

                    this.extractKeys(this, installationId + ".events", data, null, true);
                })
                .catch((error) => {
                    if (error.response && error.response.status === 401) {
                        error.response && this.log.debug(JSON.stringify(error.response.data));

                        this.log.info("Get Events receive 401 error. Refresh Token in 30 seconds");
                        clearTimeout(this.refreshTokenTimeout);
                        this.refreshTokenTimeout = setTimeout(() => {
                            this.refreshToken();
                        }, 1000 * 30);

                        return;
                    }
                    if (error.response && error.response.status === 429) {
                        this.log.info("Rate limit reached. Will be reseted next day 02:00");
                    }
                    if (error.response && error.response.status === 502) {
                        this.log.info(JSON.stringify(error.response.data));
                        this.log.info("Please check the connection of your gateway");
                    }
                    if (error.response && error.response.status === 504) {
                        this.log.info("Viessmann API is not available please try again later");
                    }
                    this.log.error("Receiving Events");
                    this.log.error(error);
                    error.response && this.log.debug(JSON.stringify(error.response.data));
                });
        }
    }

    async refreshToken() {
        await this.requestClient({
            method: "post",
            url: "https://iam.viessmann.com/idp/v2/token",
            headers: {
                "User-Agent": this.userAgent,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data: "grant_type=refresh_token&client_id=" + this.config.client_id + "&refresh_token=" + this.session.refresh_token,
        })
            .then((res) => {
                this.log.debug(JSON.stringify(res.data));
                this.session = res.data;
                this.setState("info.connection", true, true);
                return res.data;
            })
            .catch((error) => {
                this.setState("info.connection", false, true);
                this.log.error("refresh token failed");
                this.log.error(error);
                error.response && this.log.error(JSON.stringify(error.response.data));
                this.log.error("Start relogin in 1min");
                this.reLoginTimeout = setTimeout(() => {
                    this.login();
                }, 1000 * 60 * 1);
            });
    }
    getCodeChallenge() {
        let hash = "";
        let result = "";
        const chars = "0123456789abcdef";
        result = "";
        for (let i = 64; i > 0; --i) result += chars[Math.floor(Math.random() * chars.length)];
        hash = crypto.createHash("sha256").update(result).digest("base64");
        hash = hash.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

        return [result, hash];
    }
    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.setState("info.connection", false, true);
            clearTimeout(this.refreshTimeout);
            clearTimeout(this.reLoginTimeout);
            clearTimeout(this.refreshTokenTimeout);
            clearInterval(this.updateInterval);
            clearInterval(this.eventInterval);
            clearInterval(this.refreshTokenInterval);
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        if (state) {
            if (!state.ack) {
                if (id.indexOf(".setValue") === -1) {
                    this.log.info("please use setValue Object to set values");
                    return;
                }
                const deviceId = id.split(".")[2];
                const parentPath = id.split(".").slice(1, -1).slice(1).join(".");

                const uriState = await this.getStateAsync(parentPath + ".uri");
                const idState = await this.getObjectAsync(parentPath + ".setValue");

                const data = {};

                const param = idState.common.param;
                if (param) {
                    if (typeof param !== "object" || !Array.isArray(param)) {
                        data[param] = state.val;
                        if (!isNaN(state.val)) {
                            data[param] = Number(state.val);
                        }
                    } else {
                        try {
                            const stateval = JSON.parse(state.val);
                            for (const entry of param) {
                                if (typeof stateval[entry.param] !== "undefined") {
                                    data[entry.param] = stateval[entry.param];
                                    if (!isNaN(data[entry.param])) {
                                        data[entry.param] = Number(data[entry.param]);
                                    }
                                }
                            }
                        } catch (error) {
                            this.log.error(error);
                            this.log.info(`Please use a valid JSON: {"slope": x, "shift": y}`);
                        }
                    }
                }

                if (!uriState || !uriState.val) {
                    this.log.info("No URI found");
                    return;
                }

                this.log.debug("Data to send: " + JSON.stringify(data));

                const headers = {
                    "Content-Type": "application/json",
                    Accept: "*/*",
                    "User-Agent": this.userAgent,
                    Authorization: "Bearer " + this.session.access_token,
                };
                await this.requestClient({
                    method: "post",
                    url: uriState.val,
                    headers: headers,
                    data: data,
                    raxConfig: {
                        retry: 5,
                        noResponseRetries: 2,
                        retryDelay: 5000,
                        backoffType: "static",
                        statusCodesToRetry: [[500, 599]],
                        onRetryAttempt: (error) => {
                            const cfg = rax.getConfig(error);
                            if (error.response) {
                                this.log.error(JSON.stringify(error.response.data));
                            }
                            this.log.info(`Retry attempt #${cfg.currentRetryAttempt}`);
                        },
                    },
                })
                    .then((res) => {
                        this.log.debug(JSON.stringify(res.data));
                        return res.data;
                    })
                    .catch((error) => {
                        this.log.error(error);
                        if (error.response) {
                            this.log.error(JSON.stringify(error.response.data));
                        }
                        if (error.response && error.response.data && error.response.data.extendedPayload && error.response.data.extendedPayload.code === 404) {
                            this.log.error("Command not exist please. Please delete objects manually and restart the adapter");
                            return;
                        }
                        this.log.error("URL: " + uriState.val);
                        this.log.error("Data: " + JSON.stringify(data));
                    });
                this.refreshTimeout = setTimeout(async () => {
                    await this.updateDevices();
                }, 10 * 1000);
            }
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Viessmannapi(options);
} else {
    // otherwise start the instance directly
    new Viessmannapi();
}
