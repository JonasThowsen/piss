{ pkgs }:

let
  ocamlPackages = pkgs.ocaml-ng.ocamlPackages_5_2;

  # Keep the released Bonsai fixes isolated from the OCaml 5.5 server package set.
  replace =
    pname: replacement: inputs:
    map (input: if (input.pname or null) == pname then replacement else input) inputs;

  unbreak =
    package:
    package.overrideAttrs (old: {
      meta = old.meta // {
        broken = false;
      };
    });

  js_of_ocaml_patches = unbreak ocamlPackages.js_of_ocaml_patches;

  virtual_dom = ocamlPackages.virtual_dom.overrideAttrs (old: {
    meta = old.meta // {
      broken = false;
    };
    propagatedBuildInputs = replace "js_of_ocaml_patches" js_of_ocaml_patches old.propagatedBuildInputs;
  });

  async_js = unbreak ocamlPackages.async_js;

  ppx_css = ocamlPackages.ppx_css.overrideAttrs (old: {
    meta = old.meta // {
      broken = false;
    };
    propagatedBuildInputs = replace "virtual_dom" virtual_dom old.propagatedBuildInputs;
    postPatch = (old.postPatch or "") + ''
      substituteInPlace vendor/css_parser/src/lexer.ml \
        --replace-fail "'\160' .. '\255'" "0xA0 .. 0xFF"
    '';
  });

  incr_dom = ocamlPackages.incr_dom.overrideAttrs (old: {
    propagatedBuildInputs = replace "async_js" async_js (
      replace "virtual_dom" virtual_dom old.propagatedBuildInputs
    );
  });

  bonsai = ocamlPackages.bonsai.overrideAttrs (old: {
    nativeBuildInputs = replace "ppx_css" ppx_css old.nativeBuildInputs;
    propagatedBuildInputs = replace "incr_dom" incr_dom (
      replace "ppx_css" ppx_css (
        replace "cohttp-async" ocamlPackages.cohttp-async_5_3 old.propagatedBuildInputs
      )
    );
  });

  js_of_ocaml_compiler = builtins.head (
    builtins.filter (
      package: (package.pname or null) == "js_of_ocaml-compiler"
    ) bonsai.nativeBuildInputs
  );
in
{
  inherit bonsai js_of_ocaml_compiler ocamlPackages;
}
