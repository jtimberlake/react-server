import webpack from "webpack"
import path from "path"
import mkdirp from "mkdirp"
import fs from "fs"
import serverSideHotModuleReload from "./serverSideHotModuleReload"


// commented out to please eslint, but re-add if logging is needed in this file.
// import {logging} from "react-server"
// const logger = logging.getLogger(__LOGGER__);

// compiles the routes file for browser clients using webpack.
// returns a tuple of { compiler, serverRoutes }. compiler is a webpack compiler
// that is ready to have run called, and serverRoutes is a promise that resolve to
// a path to the transpiled server routes file path. The promise only resolves
// once the compiler has been run. The file path returned from the promise
// can be required and passed in to reactServer.middleware().
// TODO: add options for sourcemaps.
export default (opts = {}) => {
	const {
		routes,
		webpackConfig,
		workingDir = "./__clientTemp",
		routesDir = ".",
		outputDir = workingDir + "/build",
		outputUrl = "/static/",
		hot = true,
		minify = false,
		stats = false,
		longTermCaching = false,
	} = opts;

	if (longTermCaching && hot) {
		// chunk hashes can't be used in hot mode, so we can't use long-term caching
		// and hot mode at the same time.
		throw new Error("Hot reload cannot be used with long-term caching. Please disable either long-term caching or hot reload.");
	}

	const workingDirAbsolute = path.resolve(process.cwd(), workingDir);
	mkdirp.sync(workingDirAbsolute);
	const outputDirAbsolute = path.resolve(process.cwd(), outputDir);
	mkdirp.sync(outputDirAbsolute);

	const routesDirAbsolute = path.resolve(process.cwd(), routesDir);

	// for each route, let's create an entrypoint file that includes the page file and the routes file
	let bootstrapFile = writeClientBootstrapFile(workingDirAbsolute, opts);

	// This is required because WebpackDevServer uses Node's url module to parse the URL.  That module does not
	// support protocol-relative URLs, therefore doesn't actually parse the URL properly.  We can "fake" out the
	// url module by specifying http://.  Don't worry, WebpackDevServer will actually use window.location.protocol
	// instead of what we hardcode.
	// Node issue: https://github.com/nodejs/node-v0.x-archive/issues/9123
	// WebpackDevServer overriding protocol: https://github.com/webpack/webpack-dev-server/blob/master/client/index.js#L123-L129
	let webpackDevServerClientUrl = outputUrl;
	if (/^\/\//.test(outputUrl)) {
		// this is a protocol relative URL like '//0.0.0.0'
		webpackDevServerClientUrl = "http:" + outputUrl;
	}
	const entrypointBase = hot ? [
		require.resolve("webpack-dev-server/client") + "?" + webpackDevServerClientUrl,
		require.resolve("webpack/hot/only-dev-server"),
	] : [];
	let entrypoints = {};
	for (let routeName of Object.keys(routes.routes)) {
		let route = routes.routes[routeName];
		let formats = normalizeRoutesPage(route.page);
		for (let format of Object.keys(formats)) {
			const absolutePathToPage = require.resolve(path.resolve(routesDirAbsolute, formats[format]));

			entrypoints[`${routeName}${format !== "default" ? "-" + format : ""}`] = [
				...entrypointBase,
				bootstrapFile,
				absolutePathToPage,
			];
		}
	}

	// now rewrite the routes file out in a webpack-compatible way.
	writeWebpackCompatibleRoutesFile(routes, routesDir, workingDirAbsolute, null, true);

	// finally, let's pack this up with webpack.

	// support legacy webpack configuration name
	const userWebpackConfigOpt = webpackConfig || opts['webpack-config'];

	const clientConfig = getWebpackConfig(userWebpackConfigOpt, {
		isServer: false,
		outputDir: outputDirAbsolute,
		entrypoints,
		outputUrl,
		hot,
		minify,
		longTermCaching,
		stats,
	});
	const compiler = webpack(clientConfig);

	const serverRoutes = new Promise((resolve) => {
		compiler.plugin("done", (stats) => {
			const manifest = statsToManifest(stats);
			fs.writeFileSync(path.join(outputDir, "manifest.json"), JSON.stringify(manifest));

			// this file is generated by the build in non-hot mode, but we don't need
			// it (we got the data ourselves from stats in statsToManifest()).
			if (!hot) {
				fs.unlinkSync(path.join(outputDir, "chunk-manifest.json"));
			}

			const routesFilePath = writeWebpackCompatibleRoutesFile(routes, routesDir, workingDirAbsolute, outputUrl, false, manifest);

			if (hot) {
				serverSideHotModuleReload(stats);
			}

			resolve(routesFilePath);
		});
	});

	return {
		serverRoutes,
		compiler,
	};
}

// get the webpack configuration object
// loads data from default configuration at webpack/webpack.config.fn.js, and
// extends it by calling user-supplied function, if one was provided
function getWebpackConfig(userWebpackConfigOpt, wpAffectingOpts) {

	let extend = (data) => { return data }
	if (userWebpackConfigOpt) {
		const userWebpackConfigPath = path.resolve(process.cwd(), userWebpackConfigOpt);
		const userWebpackConfigFunc = require(userWebpackConfigPath);
		extend = userWebpackConfigFunc.default;
	}

	const baseConfig = require(path.join(__dirname, "webpack/webpack.config.fn.js"))(wpAffectingOpts);
	return extend(baseConfig);
}

// takes in the stats object from a successful compilation and returns a manifest
// object that characterizes the results of the compilation for CSS/JS loading
// and integrity checking. the manifest has the following entries:
//   jsChunksByName: an object that maps chunk names to their JS entrypoint file.
//   cssChunksByName: an object that maps chunk names to their CSS file. Note that
//     not all named chunks necessarily have a CSS file, so not all names will
//     show up as a key in this object.
//   jsChunksById: an object that maps chunk ids to their JS entrypoint file.
//   hash: the overall hash of the build, which can be used to check integrity
//     with prebuilt sources.
function statsToManifest(stats) {
	const jsChunksByName = {};
	const cssChunksByName = {};
	const jsChunksById = {};
	for (const chunk of stats.compilation.chunks) {
		if (chunk.name) {
			jsChunksByName[chunk.name] = chunk.files[0];

			for (let i = 1; i < chunk.files.length; i++) {
				if (/\.css$/.test(chunk.files[i])) {
					// the CSS file is probably last file in the array, unless there have been hot updates for the JS
					// which show up in the array prior to the CSS file.
					cssChunksByName[chunk.name] = chunk.files[i];
					break;
				}
			}
		}
		jsChunksById[chunk.id] = chunk.files[0];
	}
	return {
		jsChunksByName,
		jsChunksById,
		cssChunksByName,
		hash: stats.hash,
	};
}

// writes out a routes file that can be used at runtime.
export function writeWebpackCompatibleRoutesFile(routes, routesDir, workingDirAbsolute, staticUrl, isClient, manifest) {
	let routesOutput = [];

	const coreMiddleware = JSON.stringify(require.resolve("react-server-core-middleware"));
	const existingMiddleware = routes.middleware ? routes.middleware.map((middlewareRelativePath) => {
		return `unwrapEs6Module(require(${JSON.stringify(path.relative(workingDirAbsolute, path.resolve(routesDir, middlewareRelativePath)))}))`
	}) : [];
	routesOutput.push(`
var manifest = ${manifest ? JSON.stringify(manifest) : "undefined"};
function unwrapEs6Module(module) { return module.__esModule ? module.default : module }
var coreJsMiddleware = require(${coreMiddleware}).coreJsMiddleware;
var coreCssMiddleware = require(${coreMiddleware}).coreCssMiddleware;
module.exports = {
	middleware:[
		coreJsMiddleware(${JSON.stringify(staticUrl)}, manifest),
		coreCssMiddleware(${JSON.stringify(staticUrl)}, manifest),
		${existingMiddleware.join(",")}
	],
	routes:{`);

	for (let routeName of Object.keys(routes.routes)) {
		let route = routes.routes[routeName];

		// On the line below specifying 'method', if the route doesn't have a method, we'll set it to `undefined` so that
		// routr passes through and matches any method
		// https://github.com/yahoo/routr/blob/v2.1.0/lib/router.js#L49-L57
		let method = route.method;

		// Safely check for an empty object, array, or string and specifically set it to 'undefined'
		if (method === undefined || method === null || method === {} || method.length === 0) {
			method = undefined; // 'undefined' is the value that routr needs to accept any method
		}

		routesOutput.push(`
		${routeName}: {
			path: ${JSON.stringify(route.path)},
			method: ${JSON.stringify(method)},`);

		let formats = normalizeRoutesPage(route.page);
		routesOutput.push(`
			page: {`);
		for (let format of Object.keys(formats)) {
			const formatModule = formats[format];
			var relativePathToPage = JSON.stringify(path.relative(workingDirAbsolute, path.resolve(routesDir, formatModule)));
			routesOutput.push(`
				${format}: function() {
					return {
						done: function(cb) {`);
			if (isClient) {
				routesOutput.push(`
							require.ensure(${relativePathToPage}, function() {
								cb(unwrapEs6Module(require(${relativePathToPage})));
							});`);
			} else {
				routesOutput.push(`
							try {
								cb(unwrapEs6Module(require(${relativePathToPage})));
							} catch (e) {
								console.error('Failed to load page at ${relativePathToPage}', e.stack);
							}`);
			}
			routesOutput.push(`
						}
					};
				},`);
		}
		routesOutput.push(`
			},
		},`);
	}
	routesOutput.push(`
	}
};`);

	const routesContent = routesOutput.join("");
	// make a unique file name so that when it is required, there are no collisions
	// in the module loader between different invocations.
	const routesFilePath = `${workingDirAbsolute}/routes_${isClient ? "client" : "server"}.js`;
	fs.writeFileSync(routesFilePath, routesContent);

	return routesFilePath;
}


// the page value for routes.routes["SomeRoute"] can either be a string for the default
// module name or an object mapping format names to module names. This method normalizes
// the value to an object.
function normalizeRoutesPage(page) {
	if (typeof page === "string") {
		return {default: page};
	}
	return page;
}

// writes out a bootstrap file for the client which in turn includes the client
// routes file. note that outputDir must be the same directory as the client routes
// file, which must be named "routes_client".
function writeClientBootstrapFile(outputDir, opts) {
	var outputFile = outputDir + "/entry.js";
	fs.writeFileSync(outputFile, `
		if (typeof window !== "undefined") {
			window.__setReactServerBase = function(path) {
				// according to http://webpack.github.io/docs/configuration.html#output-publicpath
				// we should never set __webpack_public_path__ when hot module replacement is on.
				if (!module.hot) {
					__webpack_public_path__ = path;
				}
				window.__reactServerBase = path;
			}
		}
		var reactServer = require("react-server");
		window.rfBootstrap = function() {
			reactServer.logging.setLevel('main',  ${JSON.stringify(opts.logLevel)});
			reactServer.logging.setLevel('time',  ${JSON.stringify(opts.timingLogLevel)});
			reactServer.logging.setLevel('gauge', ${JSON.stringify(opts.gaugeLogLevel)});
			new reactServer.ClientController({routes: require("./routes_client")}).init();
		}`
	);
	return outputFile;
}
