async function codeyPrepareServiceTier() {
  let urls = [], scope;
  for (let attempt = 0; attempt < 100; attempt++) {
    urls = [...new Set([...document.querySelectorAll('script[src],link[rel="modulepreload"][href]')]
    .map((element) => element.src || element.href)
    .concat(performance.getEntriesByType("resource").map((entry) => entry.name))
    .filter((url) => /\/app-initial[^/]*\.js(?:[?#]|$)/.test(url)))];
    scope = codeyServiceTierScope();
    if (urls.length && scope) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (urls.length !== 1) throw new Error("无法唯一定位服务档位模块");
  const module = await import(urls[0]);
  const readers = [...new Set(Object.values(module))].filter((value) =>
    typeof value === "function" && (value.__codeyServiceTier === 1
      || value.toString().includes("Failed to read service tier for request")));
  if (readers.length !== 1) throw new Error("无法唯一定位服务档位读取函数");
  const reader = readers[0];
  if (reader.__codeyServiceTier === 1) return { ready: true };
  const response = await fetch(urls[0]);
  if (!response.ok) throw new Error("读取服务档位模块失败");
  const expression = codeyServiceTierExpression(await response.text());
  if (!scope) throw new Error("无法定位服务档位读取作用域");
  return { reader, scope, expression,
    check: () => Object.values(module).some((value) => value?.__codeyServiceTier === 1) };
}

function codeyServiceTierScope() {
  const queue = [], seen = new WeakSet();
  for (const element of [document.querySelector("#root"), document.body,
    ...document.querySelectorAll("[data-app-action-sidebar-thread-row]")].filter(Boolean).slice(0, 32)) {
    for (const key of Object.keys(element).filter((name) => /^__react(Fiber|Container|InternalInstance)\$/.test(name))) {
      for (let fiber = element[key], depth = 0; fiber && depth < 32; fiber = fiber.return, depth++) {
        queue.push(fiber.memoizedState, fiber.memoizedProps, fiber.dependencies, fiber.updateQueue);
      }
    }
  }
  for (let cursor = 0; cursor < queue.length && cursor < 12000; cursor++) {
    const value = queue[cursor];
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (["get", "set", "watch", "when"].every((key) => typeof value[key] === "function")
      && Object.hasOwn(value, "query")) return value;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!["return", "child", "sibling", "stateNode", "_owner"].includes(key)
        && descriptor.value && typeof descriptor.value === "object") queue.push(descriptor.value);
    }
  }
  return null;
}

function codeyServiceTierExpression(source) {
  const functions = [...source.matchAll(/(?:async )?function ([$\w]+)\(/g)].flatMap((match) => {
    const tail = source.slice(match.index);
    const end = tail.search(/}(?=\s*(?:(?:async )?function |var |$))/);
    return end < 0 ? [] : [{ name: match[1], source: tail.slice(0, end + 1) }];
  });
  const unique = (predicate, label) => {
    const matches = functions.filter(({ source }) => predicate(source));
    if (matches.length !== 1) throw new Error(`服务档位${label}形态不兼容`);
    return matches[0];
  };
  const read = unique((s) => s.includes("Failed to read service tier for request"), "读取");
  const ui = unique((s) => s.includes("isServiceTierAllowed:") && s.includes("authMethod:")
    && !s.includes("selectedServiceTier:"), "权限");
  const selection = unique((s) => s.includes("serviceTierForRequest:") && s.includes("selectedServiceTier:"), "选择");
  const args = read.source.match(/^async function [$\w]+\(([$\w]+),([$\w]+),([$\w]+),([$\w]+)\)/);
  const permission = read.source.match(/let ([$\w]+)=await ([$\w]+)\(([$\w]+),([$\w]+)\);/);
  const model = read.source.match(/await ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+)\?\?([$\w]+)\.model\)/);
  const config = read.source.match(/let\{config:([$\w]+)\}=await ([$\w]+)\(([$\w]+),([$\w]+),\{includeLayers:!1,cwd:null\},\{priority:`critical`\}\),([$\w]+)=([$\w]+)\(\1\)/);
  const normalize = selection.source.match(/([$\w]+)=([$\w]+)==null\?null:([$\w]+)\(([$\w]+),\2\)(?:,\2=\1)?;let /);
  if (!args || !permission || !model || !config || !normalize
    || permission[3] !== args[1] || permission[4] !== args[2]) {
    throw new Error("服务档位依赖形态不兼容");
  }
  const replaceOne = (input, pattern, replacement) => {
    let count = 0;
    const output = input.replace(pattern, (...values) => { count++; return replacement(...values); });
    if (count !== 1) throw new Error("服务档位补偿匹配次数异常");
    return output;
  };
  const readerSource = read.source.replace(permission[0], `let ${permission[1]}=!0;`);
  const uiSource = replaceOne(ui.source,
    /([$\w]+)=(?:[$\w]+&&![$\w]+&&([$\w]+)!=null&&\2\?\.requirements\?\.featureRequirements\?\.fast_mode!==!1|!0)(?=,[$\w]+;return)/g,
    (_m, name) => `${name}=!0`);
  let selectionSource = replaceOne(selection.source,
    /\?(?:([$\w]+)\?)?([$\w]+)(?::null)?:([$\w]+)\(([$\w]+),\2(?:,\1)?\)/g,
    (_m, _allowed, tier, resolver, model) => `?${tier}:${resolver}(${model},${tier})`);
  selectionSource = replaceOne(selectionSource,
    /([$\w]+)=([$\w]+)==null\?null:([$\w]+)\(([$\w]+),\2\)(?:,\2=\1)?;let /g,
    (_m, selected, requested, validate, model) => `${selected}=${requested}==null?null:${validate}(${model},${requested}),${requested}=${selected};let `);
  selectionSource = replaceOne(selectionSource,
    /(=[$\w]+\.isLoading\|\|[$\w]+\|\|[$\w]+\.isLoading(?:\|\|[$\w]+\?\.isLoading===!0)?)(?:\|\|[$\w]+==null&&[$\w]+)?(?=,)/g,
    (_m, loading) => loading);
  // Direct eval runs in the native module frame, preserving its private imports.
  // Build every replacement before assigning any module binding.
  return `(() => {
    if (${read.name}.__codeyServiceTier === 1) return true;
    const expected = ${JSON.stringify([read.source, ui.source, selection.source])};
    if (![${read.name},${ui.name},${selection.name}].every((fn, index) =>
      typeof fn === 'function' && Function.prototype.toString.call(fn) === expected[index])) {
      throw new Error('服务档位模块源码已变化');
    }
    const originalRead = (${readerSource});
    const validate = ${normalize[3]}, findModel = ${model[1]};
    const nextUi = (${uiSource}), nextSelection = (${selectionSource});
    const nextRead = async function codeyReadServiceTier(scope, host, modelId, tier) {
      const selected = await originalRead(scope, host, modelId, tier);
      if (selected == null) return null;
      try {
        if (modelId == null) {
          const result = await ${config[2]}(scope, host, {includeLayers:false,cwd:null}, {priority:'critical'});
          modelId = ${config[6]}(result.config).model;
        }
        return validate(await findModel(scope, host, modelId), selected);
      } catch (error) {
        console.error('[Codey] service tier model validation failed', error);
        throw error;
      }
    };
    nextRead.__codeyServiceTier = 1;
    ${ui.name} = nextUi;
    ${selection.name} = nextSelection;
    ${read.name} = nextRead;
    return true;
  })()`;
}
