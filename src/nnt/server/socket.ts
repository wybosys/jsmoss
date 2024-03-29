import {AbstractServer, IConsoleServer} from "./server"
import {Node} from "../config/config"
import {IRouterable, Routers} from "./routers";
import {AcEntity} from "../acl/acl";
import {IndexedObject, nonnull1st, ObjectT, toJson} from "../core/kernel";
import {Config} from "../manager/config";
import {logger} from "../core/logger";
import {expand} from "../core/url";
import {FindDecoder, IDecoder, RegisterDecoder} from "./socket/decoder";
import {JsonDecoder} from "./socket/jsondecoder";
import {Transaction as BaseTransaction} from "./transaction";
import {STATUS} from "../core/models";
import {ConsoleOutput, ConsoleSubmit, Find} from "../manager/servers";
import {RSocket} from "./socket/router";
import {CancelDelay, Delay} from "../core/time";
import {ListenMode} from "./rest/listener";
import {Variant} from "../core/object";
import {Output} from "../core/proto";
import {IHttpServer} from "./apiserver";
import {static_cast} from "../core/core";
import ws = require("ws");
import http = require("http");
import https = require("https");
import fs = require("fs");
import {AbstractRender, FindRender} from "./render/render";
import {FindParser} from "./parser/parser";

export type SocketOutputType = string | Buffer | ArrayBuffer;

// 超过时间后不登陆，断开连接
const DEFAULT_AUTH_TIMEOUT = 10;

interface WsNode extends Node {

    // 监听的地址
    listen: string;

    // 端口
    port: number;

    // 绑定到当前已经存在的http服务
    attach: string;

    // 是否加密
    wss?: boolean;

    // 验证超时事件
    authtimeout: number;
}

RegisterDecoder("/json", new JsonDecoder());

export abstract class Transaction extends BaseTransaction {

    modelId(): number {
        return this.params['_cmid'];
    }
}

export class Connector {

    sessionId: string;
    clientId: string;

    // 输出的渲染器
    render: AbstractRender;

    // 初始化
    init(trans: Transaction): boolean {
        this.sessionId = trans.sessionId();
        this.clientId = trans.clientId();
        return true;
    }

    // 输出数据
    send(msg: SocketOutputType) {
        if (!this._hdl) {
            logger.warn("连接丢失，不能发送消息");
            return;
        }
        this._hdl.send(msg, err => {
            if (err)
                logger.error(err);
        });
    }

    get isClosed(): boolean {
        return this._hdl == null;
    }

    // 主动关闭连接
    close(retcode: number, msg?: string) {
        if (this._hdl) {
            Connector.CloseHandle(this._hdl, retcode, msg);
            this.onClosed();
        }
    }

    // 连接关闭的回调
    onClosed() {
        this._hdl = null;
    }

    // 是否已经登陆
    authed: boolean = false;

    // 连接句柄
    private _hdl: ws;

    static CloseHandle(hdl: ws, code?: number, msg?: string) {
        if (code) {
            hdl.close(4000, toJson({
                code: code,
                message: msg
            }));
        }
        else {
            hdl.close(4000);
        }
    }
}

function BindHdlToConnector(cnt: Connector, hdl: ws) {
    cnt["_hdl"] = hdl;
}

export abstract class Socket extends AbstractServer implements IRouterable, IConsoleServer {

    constructor() {
        super();
        this.routers.register(new RSocket());
    }

    // 实例事务
    protected abstract instanceTransaction(): Transaction;

    // 实例连接器
    protected instanceConnector(): Connector {
        return new Connector();
    }

    config(cfg: Node): boolean {
        if (!super.config(cfg))
            return false;
        let c = <WsNode>cfg;
        if (c.attach) {
            // 如果设置了attach，就不能再监听到独立端口
            this.attach = c.attach;
        }
        else {
            if (!c.port)
                return false;
            this.listen = null;
            if (c.listen && c.listen != "*")
                this.listen = c.listen;
            this.port = c.port;
            this.wss = nonnull1st(false, c.wss, Config.HTTPS);
            if (this.wss) {
                if (Config.HTTPS_PFX) {
                    // pass
                }
                else if (Config.HTTPS_KEY && Config.HTTPS_CERT) {
                    // pass
                }
                else {
                    logger.warn("没有配置https的证书");
                    return false;
                }
            }
        }
        this.authtimeout = c.authtimeout ? c.authtimeout : DEFAULT_AUTH_TIMEOUT;
        return true;
    }

    listen: string;
    port: number;
    wss: boolean;
    attach: string;
    authtimeout: number;

    protected _srv: http.Server | https.Server;
    protected _hdl: ws.Server;

    async start(): Promise<void> {
        if (!this.attach) {
            if (this.wss) {
                let cfg: IndexedObject = {};
                if (Config.HTTPS_PFX) {
                    cfg["pfx"] = fs.readFileSync(expand(Config.HTTPS_PFX));
                }
                else {
                    cfg["key"] = fs.readFileSync(expand(Config.HTTPS_KEY));
                    cfg["cert"] = fs.readFileSync(expand(Config.HTTPS_CERT));
                }
                if (Config.HTTPS_PASSWD)
                    cfg["passphrase"] = Config.HTTPS_PASSWD;
                this._srv = https.createServer(cfg, (req, rsp) => {
                    rsp.writeHead(200);
                    rsp.end();
                });
            }
            else {
                this._srv = http.createServer((req, rsp) => {
                    rsp.writeHead(200);
                    rsp.end();
                });
            }
            this._srv.listen(this.port, this.listen ? this.listen : "0.0.0.0");
        }
        else {
            // ws服务服用http的连接
            let srv = static_cast<IHttpServer>(Find(this.attach));
            this._srv = srv.httpserver();
        }

        this._hdl = new ws.Server({server: this._srv});
        this.doWorker();
        logger.info("启动 {{=it.id}}@socket", {id: this.id});
        this.onStart();
    }

    protected doWorker() {
        this._hdl.on("connection", (io, req) => {
            let addr = req.connection.remoteAddress;

            // 根据连接的url查询支持的编解码环境
            let dec = FindDecoder(req.url);
            if (!dec) {
                logger.log("{{=it.addr}} 请求了错误的连接格式 {{=it.url}}", {addr: addr, url: req.url});
                Connector.CloseHandle(io, STATUS.SOCK_WRONG_PORTOCOL);
                return;
            }
            logger.log("{{=it.addr}} 连接服务器", {addr: addr});

            // 监听socket的数据消息
            io.on("close", (code, reason) => {
                logger.log("{{=it.addr}} 断开连接", {addr: addr});

                let cnt: Connector = ObjectT.Get(io, IO_CONNECTOR);
                if (cnt) {
                    this.onConnectorUnavaliable(cnt);
                    BindHdlToConnector(cnt, null);
                    ObjectT.Set(io, IO_CONNECTOR, null);
                    cnt.onClosed();
                }
            });

            io.on("message", data => {
                // 解析请求
                let obj = dec.decode(data);

                // 如果不存在客户端模型id，则代表请求非法
                if (!obj || !obj["_cmid"]) {
                    logger.log("{{=it.addr}} 提交了非法数据", {addr: addr});
                    return;
                }

                // 转由invoke处理
                this.invoke(obj, req, io);
            });

            // 如果长期不登录，则断开连接
            let tmr = Delay(this.authtimeout, () => {
                logger.log("{{=it.addr}} 断开无效连接", {addr: addr});
                Connector.CloseHandle(io, STATUS.SOCK_AUTH_TIMEOUT);
            });
            ObjectT.Set(io, IO_TIMEOUT, tmr);
        });
    }

    async stop(): Promise<void> {
        this.onStop();
        this._srv.close();
        this._srv = null;
    }

    protected _routers = new Routers();
    get routers(): Routers {
        return this._routers;
    }

    invoke(params: any, req: http.IncomingMessage, rsp: ws, ac?: AcEntity) {
        let t: Transaction = this.instanceTransaction();
        try {
            t.ace = ac;
            t.server = this;
            t.action = params.action;
            t.params = params;

            // 绑定解析器
            t.parser = FindParser(params['_pfmt']);
            t.render = FindRender(params['_rfmt']);

            this.onBeforeInvoke(t);
            this.doInvoke(t, params, req, rsp, ac);
            this.onAfterInvoke(t);
        }
        catch (err) {
            logger.exception(err);
            t.status = STATUS.EXCEPTION;
            t.submit();
        }
    }

    protected onBeforeInvoke(trans: Transaction) {
        // pass
    }

    protected onAfterInvoke(trans: Transaction) {
        // pass
    }

    protected doInvoke(t: Transaction, params: any, req: http.IncomingMessage, rsp: ws, ac?: AcEntity) {
        if (req && rsp) {
            t.payload = {req: req, rsp: rsp};
            t.implSubmit = TransactionSubmit;
            t.implOutput = TransactionOutput;
        }
        else {
            t.implSubmit = ConsoleSubmit;
            t.implOutput = ConsoleOutput;
        }

        if (rsp) {
            // 判断是否是新连接
            let connector: Connector = ObjectT.Get(rsp, IO_CONNECTOR);
            if (!connector) {
                // 建立全新连接
                connector = this.instanceConnector();
                connector.render = t.render;

                BindHdlToConnector(connector, rsp);
                ObjectT.Set(rsp, IO_CONNECTOR, connector);

                // 如果是listen或者unlisten，则不做任何返回
                if (params["_listen"] === ListenMode.LISTEN) {
                    this._routers.listen(t).then(() => {
                        if (t.status == STATUS.OK) {
                            this.onListen(connector, t, true);
                            // 监听成功后，调用一次接口，产生默认数据
                            this._routers.process(t);
                        }
                    });
                }
                else if (params["_listen"] === ListenMode.UNLISTEN) {
                    this._routers.listen(t).then(() => {
                        if (t.status == STATUS.OK) {
                            this.onListen(connector, t, false);
                        }
                    });
                }
                else {
                    // 新连接执行成功后，作为用户上线的标记
                    t.hookSubmit = async () => {
                        if (!connector.authed && t.status == STATUS.OK && connector.init(t)) {
                            connector.authed = true;
                            // 登陆清除timeout
                            let tmr = ObjectT.Get(rsp, IO_TIMEOUT);
                            CancelDelay(tmr);
                            ObjectT.Set(rsp, IO_TIMEOUT, null);

                            // 登陆成功
                            await this.onConnectorAvaliable(connector);
                        }
                    };
                    this._routers.process(t);
                }
            }
            else {
                if (params["_listen"] === ListenMode.LISTEN) {
                    this._routers.listen(t).then(() => {
                        if (t.status == STATUS.OK) {
                            if (connector.authed)
                                connector.init(t);
                            this.onListen(connector, t, true);
                            this._routers.process(t);
                        }
                    });
                }
                else if (params["_listen"] === ListenMode.UNLISTEN) {
                    this._routers.listen(t).then(() => {
                        if (t.status == STATUS.OK) {
                            if (connector.authed)
                                connector.init(t);
                            this.onListen(connector, t, false);
                        }
                    });
                }
                else {
                    // 已经登录，则直接先初始化事务
                    if (connector.authed) {
                        connector.init(t);
                        // 直接调用处理逻辑
                        this._routers.process(t);
                    }
                    else {
                        // 需要额外处理登录
                        t.hookSubmit = async () => {
                            if (t.status == STATUS.OK && connector.init(t)) {
                                // 如果没有登录，需要初始化登录数据
                                connector.authed = true;

                                // 登陆清除timeout
                                let tmr = ObjectT.Get(rsp, IO_TIMEOUT);
                                CancelDelay(tmr);
                                ObjectT.Set(rsp, IO_TIMEOUT, null);

                                // 登陆成功
                                await this.onConnectorAvaliable(connector);
                            }
                        };
                        this._routers.process(t);
                    }
                }
            }
        }
        else {
            this._routers.process(t);
        }
    }

    protected async onConnectorAvaliable(connector: Connector) {
    }

    protected async onConnectorUnavaliable(connector: Connector) {
    }

    protected onListen(connector: Connector, tran: Transaction, listen: boolean) {
        // 处理加监听和取消监听的动作
    }
}

const IO_CONNECTOR = "::nnt::socket::connector";
const IO_TIMEOUT = "::nnt::socket::timeout";

// 服务端不去维护客户端连接列表，避免当运行在集群中客户端分散在不同地方连接，导致通过key查询客户端连接只能查询本机连接池的问题

interface TransactionPayload {
    req: http.IncomingMessage;
    rsp: ws;
}

function TransactionSubmit() {
    let self = <Transaction>this;
    let pl: TransactionPayload = self.payload;
    let data: IndexedObject = {
        s: self.status,
        d: self.modelId(),
        p: Output(self.model),
    };
    if (self.quiet)
        data.q = 1;
    pl.rsp.send(new Variant(data).toBuffer());
}

function TransactionOutput(type: string, obj: any) {
    let self = <Transaction>this;
    let pl: TransactionPayload = self.payload;
    let data: IndexedObject = {
        s: self.status,
        d: self.modelId(),
        p: Output(self.model),
    };
    if (self.quiet)
        data.q = 1;
    pl.rsp.send(new Variant(data).toBuffer());
}
