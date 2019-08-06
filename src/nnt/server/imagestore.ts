import {Rest} from "./rest";
import {Node} from "../config/config";
import {pathd} from "../core/url";
import fs = require("fs-extra");
import {IMediaStore} from "./imediastore";
import {RImageStore} from "./rimagestore";

interface ImageStoreNode extends Node {
    // 存储图片的位置
    store: string;

    // 不安全模式(可以定义保存路径)
    unsafe: boolean;
}

export class ImageStore extends Rest implements IMediaStore {

    constructor() {
        super();
        this.routers.register(new RImageStore());
    }

    @pathd()
    store: string;
    unsafe: boolean;

    config(cfg: Node): boolean {
        if (!super.config(cfg))
            return false;
        let c = <ImageStoreNode>cfg;
        if (!c.store)
            return false;
        this.store = c.store;
        this.unsafe = c.unsafe;
        return true;
    }

    async start(): Promise<void> {
        await super.start();
        if (!fs.existsSync(this.store))
            fs.mkdirSync(this.store);
    }
}
